#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"

SUDO="${SUDO:-sudo}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-20byte-vps}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
BRANCH="${DEPLOY_BRANCH:-main}"
NGINX_UPSTREAM_SNIPPET="${NGINX_UPSTREAM_SNIPPET:-/etc/nginx/snippets/20byte-active-upstream.conf}"
ACTIVE_COLOR_FILE="${ACTIVE_COLOR_FILE:-$ROOT_DIR/.deploy/active_color}"
WEB_BLUE_PORT="${WEB_BLUE_PORT:-3100}"
WEB_GREEN_PORT="${WEB_GREEN_PORT:-3200}"
HEALTH_PATH="${HEALTH_PATH:-/api/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_DELAY="${HEALTH_DELAY:-5}"
SKIP_GIT_SYNC="${SKIP_GIT_SYNC:-0}"
KEEP_OLD_WEB="${KEEP_OLD_WEB:-0}"
DOCKER_PRUNE_AFTER_DEPLOY="${DOCKER_PRUNE_AFTER_DEPLOY:-1}"
DEPLOY_GIT_HARD_SYNC="${DEPLOY_GIT_HARD_SYNC:-0}"
DEPLOY_GIT_AUTO_STASH="${DEPLOY_GIT_AUTO_STASH:-0}"
APP_IMAGE="${APP_IMAGE:-20byte-vps-app:latest}"
DEFAULT_APP_IMAGE="20byte-vps-app:latest"
GHCR_REGISTRY="${GHCR_REGISTRY:-ghcr.io}"
GHCR_USERNAME="${GHCR_USERNAME:-}"
GHCR_TOKEN="${GHCR_TOKEN:-}"

export APP_IMAGE

active_color="legacy"
switched_upstream="0"

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    "$SUDO" "$@"
  fi
}

compose() {
  as_root env APP_IMAGE="$APP_IMAGE" "$DOCKER_BIN" compose -f docker-compose.vps.yml --project-name "$PROJECT_NAME" "$@"
}

require_file() {
  if [ ! -f "$1" ]; then
    echo "[deploy] missing required file: $1"
    exit 1
  fi
}

login_registry_if_needed() {
  if [ -z "$GHCR_USERNAME" ] || [ -z "$GHCR_TOKEN" ]; then
    echo "[deploy] registry credentials not provided, skipping docker login"
    return 0
  fi

  echo "[deploy] logging into $GHCR_REGISTRY for image pull"
  printf '%s' "$GHCR_TOKEN" | as_root "$DOCKER_BIN" login "$GHCR_REGISTRY" -u "$GHCR_USERNAME" --password-stdin >/dev/null
}

prepare_application_image() {
  if [ "$APP_IMAGE" = "$DEFAULT_APP_IMAGE" ]; then
    echo "[deploy] APP_IMAGE not provided, fallback to local VPS build"
    compose build app-image
    return 0
  fi

  login_registry_if_needed
  echo "[deploy] pulling application image $APP_IMAGE"
  compose pull migrate worker web-blue web-green
}

detect_active_color() {
  if [ -f "$ACTIVE_COLOR_FILE" ]; then
    color="$(tr -d '[:space:]' <"$ACTIVE_COLOR_FILE")"
    if [ "$color" = "blue" ] || [ "$color" = "green" ]; then
      printf '%s\n' "$color"
      return
    fi
  fi

  if [ -f "$NGINX_UPSTREAM_SNIPPET" ]; then
    if grep -q "127.0.0.1:$WEB_BLUE_PORT" "$NGINX_UPSTREAM_SNIPPET"; then
      printf 'blue\n'
      return
    fi
    if grep -q "127.0.0.1:$WEB_GREEN_PORT" "$NGINX_UPSTREAM_SNIPPET"; then
      printf 'green\n'
      return
    fi
  fi

  printf 'legacy\n'
}

inactive_color_for() {
  case "$1" in
    blue) printf 'green\n' ;;
    green) printf 'blue\n' ;;
    *) printf 'blue\n' ;;
  esac
}

port_for_color() {
  case "$1" in
    blue) printf '%s\n' "$WEB_BLUE_PORT" ;;
    green) printf '%s\n' "$WEB_GREEN_PORT" ;;
    *)
      echo "[deploy] unknown color: $1"
      exit 1
      ;;
  esac
}

write_upstream_snippet() {
  port="$1"
  tmpfile="$(mktemp)"
  printf 'proxy_pass http://127.0.0.1:%s;\n' "$port" >"$tmpfile"
  as_root install -m 644 "$tmpfile" "$NGINX_UPSTREAM_SNIPPET"
  rm -f "$tmpfile"
}

wait_for_health() {
  port="$1"
  attempt=1
  while [ "$attempt" -le "$HEALTH_RETRIES" ]; do
    if curl -fsS "http://127.0.0.1:${port}${HEALTH_PATH}" >/dev/null 2>&1; then
      echo "[deploy] healthcheck passed on port $port"
      return 0
    fi
    echo "[deploy] waiting for healthcheck on port $port (attempt $attempt/$HEALTH_RETRIES)"
    attempt=$((attempt + 1))
    sleep "$HEALTH_DELAY"
  done
  echo "[deploy] healthcheck failed on port $port"
  return 1
}

ensure_active_color_dir() {
  dir_path="$(dirname "$ACTIVE_COLOR_FILE")"
  mkdir -p "$dir_path"
}

rollback_upstream_on_failure() {
  status=$?
  if [ "$status" -eq 0 ]; then
    return 0
  fi

  if [ "$switched_upstream" != "1" ]; then
    return "$status"
  fi

  if [ "$active_color" != "blue" ] && [ "$active_color" != "green" ]; then
    echo "[deploy] deployment failed after cutover; previous active color unknown, manual rollback required"
    return "$status"
  fi

  previous_port="$(port_for_color "$active_color")"
  echo "[deploy] deployment failed after cutover; rolling back nginx upstream to $active_color ($previous_port)"
  write_upstream_snippet "$previous_port"
  if as_root nginx -t; then
    as_root systemctl reload nginx
    ensure_active_color_dir
    printf '%s\n' "$active_color" >"$ACTIVE_COLOR_FILE"
    echo "[deploy] rollback complete: active production color restored to $active_color"
  else
    echo "[deploy] rollback failed: nginx configuration test failed, manual intervention required"
  fi

  return "$status"
}

trap 'rollback_upstream_on_failure' EXIT

stop_legacy_container_if_present() {
  name="$1"
  if as_root docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
    echo "[deploy] stopping legacy container $name"
    as_root docker stop "$name" >/dev/null || true
  fi
}

require_file ".env"
require_file "docker-compose.vps.yml"
require_file "deploy/nginx/20byte.production.conf"

mkdir -p "$ROOT_DIR/.deploy"

if [ "$SKIP_GIT_SYNC" != "1" ]; then
  echo "[deploy] syncing git branch origin/$BRANCH"
  git fetch origin "$BRANCH"
  if [ "$DEPLOY_GIT_HARD_SYNC" = "1" ]; then
    echo "[deploy] impact: hard git sync will discard uncommitted files on VPS working tree"
    git reset --hard "origin/$BRANCH"
    git clean -fd
  else
    if [ "$DEPLOY_GIT_AUTO_STASH" = "1" ] && [ -n "$(git status --porcelain)" ]; then
      stash_name="pre-deploy-auto-$(date +%Y%m%d%H%M%S)"
      echo "[deploy] dirty working tree detected, auto-stashing as $stash_name"
      git stash push --include-untracked -m "$stash_name" >/dev/null
    fi
    git checkout "$BRANCH"
    git merge --ff-only "origin/$BRANCH"
  fi
fi

echo "[deploy] validating docker compose config..."
compose config >/dev/null

active_color="$(detect_active_color)"
inactive_color="$(inactive_color_for "$active_color")"
inactive_port="$(port_for_color "$inactive_color")"
inactive_service="web-$inactive_color"

echo "[deploy] active color: $active_color"
echo "[deploy] inactive color: $inactive_color ($inactive_port)"

echo "[deploy] preparing application image..."
prepare_application_image

echo "[deploy] running database migrations..."
compose run --rm migrate

echo "[deploy] starting inactive web service: $inactive_service"
compose up -d "$inactive_service"

wait_for_health "$inactive_port"

echo "[deploy] switching nginx upstream to $inactive_color"
write_upstream_snippet "$inactive_port"
as_root nginx -t
as_root systemctl reload nginx
switched_upstream="1"

ensure_active_color_dir
printf '%s\n' "$inactive_color" >"$ACTIVE_COLOR_FILE"

if [ "$active_color" = "legacy" ]; then
  stop_legacy_container_if_present "20byte_worker"
fi

echo "[deploy] recreating worker"
compose up -d --force-recreate worker

if [ "$active_color" = "legacy" ]; then
  if [ "$KEEP_OLD_WEB" != "1" ]; then
    stop_legacy_container_if_present "20byte_web"
  fi
elif [ "$KEEP_OLD_WEB" != "1" ]; then
  echo "[deploy] stopping old web service web-$active_color"
  compose stop "web-$active_color" || true
fi

echo "[deploy] current status:"
compose ps

if [ "$DOCKER_PRUNE_AFTER_DEPLOY" = "1" ]; then
  echo "[deploy] impact: docker prune removes dangling images and old builder cache"
  echo "[deploy] pruning dangling docker images"
  as_root "$DOCKER_BIN" image prune -f >/dev/null || true
  echo "[deploy] pruning docker builder cache older than 24h"
  as_root "$DOCKER_BIN" builder prune -af --filter "until=24h" >/dev/null || true
fi

echo "[deploy] active production color is now $inactive_color"
trap - EXIT

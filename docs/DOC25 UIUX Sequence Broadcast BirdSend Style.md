# DOC 25 — UI/UX Blueprint Sequence & Broadcast (BirdSend Style)

## Tujuan
- Kerjakan UI/UX dulu sebelum BE lanjutan.
- Meniru pola BirdSend yang cepat: **Sequence dulu, Rule/Trigger sesudahnya**.
- Fokus pada pengalaman 1 halaman: edit step cepat, minim pindah halaman.

## Referensi Kunci
- Referensi utama (primary):
  - https://birdsend.co/blog/how-to-set-up-email-automation/
  - UX utama mengikuti alur ini secara default.
- Referensi pendukung:
  - https://birdsend.co/1-page-sequence-builder/
- BirdSend automation 2-step:
  - Sequence setup
  - Rules/Triggers setup
- BirdSend 1-Page Sequence Builder (pendukung):
  - Edit banyak step/email dari satu halaman
  - Sidebar kanan untuk daftar step + quick stats
  - Minim back-forth navigation

## Prinsip UX yang Ditiru (Mengikuti Referensi Utama)
1. One-page builder:
- Semua step sequence bisa dibuat/edit di satu layar.
- Tidak ada perpindahan halaman per step.

2. Fast authoring:
- Tombol `Add Step` selalu terlihat.
- Edit step aktif langsung di panel utama.
- Daftar step klik-untuk-edit di sidebar kanan.

3. Rule after content:
- User selesai susun sequence dulu.
- Lalu masuk tab Rules untuk trigger dan action (if X then Y).

4. At-a-glance performance:
- Ringkasan metrik sequence muncul tanpa buka detail lain.

5. 2-step mental model yang tegas:
- Step 1: buat dan rapikan sequence.
- Step 2: baru pasang rules/triggers untuk enrollment/branching.

## Struktur Halaman `/whatsapp-campaigns`
- Tetap 4 tab:
  - `Sequences`
  - `Broadcast`
  - `Recipients`
  - `Analytics`

### A. Tab Sequences (utama)
- Layout 3 kolom:
  - Kiri: daftar sequence + status (`Draft/Active/Paused`)
  - Tengah: editor step aktif
  - Kanan: urutan step + quick metrics per step

- Header action:
  - `New Sequence`
  - `Duplicate`
  - `Save Draft`
  - `Activate/Pause`

- Step types V1 UI:
  - `Delay`
  - `Send Template`
  - `Send Text`
  - `Condition Branch`
  - `Stop`

- Behavior penting:
  - Klik step di sidebar kanan => editor tengah ganti konteks step.
  - Drag & drop urutan step (UI dulu; persist menyusul).
  - Inline validation per step (error tampil langsung).

### B. Sub-tab Rules (di dalam Sequences detail)
- Composer “If this, do that”:
  - Trigger selector:
    - Chat incoming
    - Customer reply
    - Tag added
    - Assignee changed
    - Follow-up status changed
  - Condition builder (AND/OR sederhana)
  - Action builder:
    - Enroll ke sequence
    - Stop sequence
    - Add suppression

- Rule list:
  - status toggle
  - last run
  - impacted recipients (count)

### C. Tab Broadcast
- BirdSend-like quick launch flow:
  - Audience segment picker (CRM source existing)
  - Message mode:
    - Template
    - Text (dengan warning compliance)
  - Schedule:
    - Send now
    - Schedule time
  - Preview recipient estimate

## Komponen Shadcn yang Dipakai
- `Tabs`, `Card`, `Button`, `Badge`, `Separator`
- `Dialog`, `Sheet`, `Popover`, `Tooltip`
- `Select`, `Combobox` pattern, `Input`, `Textarea`, `Switch`
- `Table`, `ScrollArea`, `Alert`, `Progress`

## Design System Ringkas
- Density: compact, cepat dibaca.
- Typography: konsisten dengan style app existing.
- Visual hierarchy:
  - sequence list (ringkas)
  - editor aktif (fokus utama)
  - step rail kanan (navigasi cepat + status)
- Empty state:
  - CTA jelas (`Create your first sequence`).

## Workflow Pencil (wajib sebelum coding FE besar)
1. Buat file wireframe:
- `Sequence list + builder 3 kolom`
- `Rules composer`
- `Broadcast quick launch`

2. Buat 3 level fidelity:
- Low-fi: struktur dan navigasi
- Mid-fi: spacing, hierarchy, states
- Hi-fi: style final sesuai app

3. Review checklist:
- Bisa bikin 10+ steps tanpa pindah halaman?
- Bisa edit step ke-7 dalam <= 2 klik?
- Rule setup selesai tanpa bingung urutan?

## Scope Implementasi FE (tanpa BE baru)
1. Sequence builder 3 kolom + step rail kanan.
2. Editor step type (`Delay`, `Template`, `Text`, `Branch`, `Stop`) UI-first.
3. Rules composer UI + local state mock.
4. Broadcast quick launch UI + validation frontend.
5. Analytics cards placeholder terhubung endpoint existing jika tersedia.

## Out of Scope Sementara
- Persist penuh branch graph engine.
- Auto-enrollment runtime logic tambahan.
- Throttling backend broadcast lanjutan.

## Acceptance Criteria UI/UX
- User dapat membuat draft sequence multi-step tanpa pindah halaman.
- User dapat menyusun minimal 1 rule trigger-action dari UI Rules.
- User dapat menyiapkan draft broadcast + preview estimasi audience.
- Navigasi tetap konsisten dengan shell/sidebar existing.

## Link Referensi
- https://birdsend.co/blog/how-to-set-up-email-automation/
- https://birdsend.co/1-page-sequence-builder/

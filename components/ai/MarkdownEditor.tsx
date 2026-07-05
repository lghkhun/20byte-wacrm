"use client";

import { useRef, useState } from "react";
import EmojiPicker, { EmojiStyle, Theme } from "emoji-picker-react";
import { Bold, Italic, List, ListOrdered, Smile, Strikethrough, Type } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type MarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  variables?: Array<{ label: string; value: string }>;
  className?: string;
};

export function MarkdownEditor({ value, onChange, placeholder, rows = 5, variables = [], className }: MarkdownEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isEmojiOpen, setIsEmojiOpen] = useState(false);
  const [selectedVar, setSelectedVar] = useState<string>("");
  const { resolvedTheme } = useTheme();

  const insertText = (before: string, after = "") => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;

    const selectedText = text.substring(start, end);
    const newText = text.substring(0, start) + before + (selectedText || (after ? "teks" : "")) + after + text.substring(end);

    onChange(newText);

    // Restore cursor position
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start + before.length, end + before.length + (selectedText ? 0 : (after ? 4 : 0)));
    }, 0);
  };

  const insertVariable = () => {
    if (!selectedVar) return;
    insertText(selectedVar);
    setSelectedVar(""); // reset
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter") {
      const textarea = e.currentTarget;
      const start = textarea.selectionStart;
      const text = textarea.value;
      const textBeforeCursor = text.substring(0, start);
      const lines = textBeforeCursor.split("\n");
      const currentLine = lines[lines.length - 1];

      // match bullet: "- " or "* "
      const bulletMatch = currentLine.match(/^(\s*)([-*])\s+(.*)$/);
      if (bulletMatch) {
        if (!bulletMatch[3].trim()) {
          // If the bullet is empty, remove the bullet
          e.preventDefault();
          const newText = text.substring(0, start - currentLine.length) + text.substring(start);
          onChange(newText);
          setTimeout(() => {
            textarea.selectionStart = textarea.selectionEnd = start - currentLine.length;
          }, 0);
          return;
        }
        e.preventDefault();
        const indent = bulletMatch[1];
        const bullet = bulletMatch[2];
        const insert = `\n${indent}${bullet} `;
        const newText = text.substring(0, start) + insert + text.substring(textarea.selectionEnd);
        onChange(newText);
        setTimeout(() => {
          textarea.selectionStart = textarea.selectionEnd = start + insert.length;
        }, 0);
        return;
      }

      // match numbered list: "1. "
      const numberMatch = currentLine.match(/^(\s*)(\d+)\.\s+(.*)$/);
      if (numberMatch) {
        if (!numberMatch[3].trim()) {
          // If the list item is empty, remove it
          e.preventDefault();
          const newText = text.substring(0, start - currentLine.length) + text.substring(start);
          onChange(newText);
          setTimeout(() => {
            textarea.selectionStart = textarea.selectionEnd = start - currentLine.length;
          }, 0);
          return;
        }
        e.preventDefault();
        const indent = numberMatch[1];
        const nextNum = parseInt(numberMatch[2], 10) + 1;
        const insert = `\n${indent}${nextNum}. `;
        const newText = text.substring(0, start) + insert + text.substring(textarea.selectionEnd);
        onChange(newText);
        setTimeout(() => {
          textarea.selectionStart = textarea.selectionEnd = start + insert.length;
        }, 0);
        return;
      }
    }
  };

  return (
    <div className={`flex flex-col overflow-hidden rounded-xl border border-input bg-background transition-colors focus-within:border-primary focus-within:ring-1 focus-within:ring-primary ${className || ""}`}>
      <div className="flex flex-wrap items-center gap-1 border-b border-input bg-muted/30 p-1.5">
        {variables && variables.length > 0 && (
          <>
            <Select value={selectedVar} onValueChange={setSelectedVar}>
              <SelectTrigger className="h-8 w-[140px] border-none bg-transparent shadow-none focus:ring-0 text-xs font-medium">
                <SelectValue placeholder="Select Autotext" />
              </SelectTrigger>
              <SelectContent>
                {variables.map((v) => (
                  <SelectItem key={v.value} value={v.value}>
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs font-semibold text-primary"
              onClick={insertVariable}
              disabled={!selectedVar}
            >
              Insert
            </Button>
            <div className="mx-1 h-4 w-px bg-border/80" />
          </>
        )}

        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => insertText("**", "**")} title="Bold">
          <Bold className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => insertText("_", "_")} title="Italic">
          <Italic className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => insertText("~~", "~~")} title="Strikethrough">
          <Strikethrough className="h-4 w-4" />
        </Button>

        <div className="mx-1 h-4 w-px bg-border/80" />

        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => insertText("- ", "")} title="Bullet List">
          <List className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => insertText("1. ", "")} title="Numbered List">
          <ListOrdered className="h-4 w-4" />
        </Button>

        <div className="mx-1 h-4 w-px bg-border/80" />

        <Popover open={isEmojiOpen} onOpenChange={setIsEmojiOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" title="Emoji">
              <Smile className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto border-none bg-transparent p-0 shadow-none" align="start">
            <EmojiPicker
              lazyLoadEmojis
              emojiStyle={EmojiStyle.APPLE}
              theme={resolvedTheme === "dark" ? Theme.DARK : Theme.LIGHT}
              onEmojiClick={(emojiData) => {
                insertText(emojiData.emoji);
                setIsEmojiOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
      </div>
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={rows}
        className="min-h-[100px] resize-y border-0 bg-transparent p-3 shadow-none focus-visible:ring-0 rounded-t-none"
        style={{ fontFamily: 'var(--font-sans), "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"' }}
      />
    </div>
  );
}

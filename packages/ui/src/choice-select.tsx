"use client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";
export function ChoiceSelect({
  label,
  value,
  disabled,
  placeholder = "请选择",
  options,
  onValueChange,
  className,
  contentClassName,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  placeholder?: string;
  options: { value: string; label: string }[];
  onValueChange: (value: string) => void;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <Select
      value={value}
      disabled={disabled || !options.length}
      onValueChange={(next) => {
        if (next) onValueChange(next);
      }}
    >
      <SelectTrigger aria-label={label} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {options
          .filter((item) => item.value)
          .map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

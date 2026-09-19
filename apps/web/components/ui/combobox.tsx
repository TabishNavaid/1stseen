"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { filterOptions, nextIndex, resultAnnouncement, type ListOption } from "@/lib/ui/listbox";
import { cn } from "@/lib/utils";
import { Icon } from "./icon";

function optionIndexFrom(target: EventTarget): number {
  const option = target instanceof Element ? target.closest<HTMLElement>("[role=option]") : null;
  return option ? Number(option.dataset.index) : -1;
}

/**
 * A searchable single-choice combobox: the ARIA 1.2 combobox pattern with a listbox popup.
 *
 * Keyboard: typing filters the options; ArrowDown and ArrowUp open the list and move through it, stopping at
 * either end; Enter chooses the active option; Escape closes the list, and a second Escape clears the text and
 * the choice; Tab leaves without choosing; Home and End stay with the text, as in a text field. Focus never
 * leaves the input: the active option is exposed with aria-activedescendant and marked aria-selected, and a
 * polite live region says how many options match. With `name`, the chosen value submits with a GET form.
 */
export function Combobox({
  id,
  label,
  options,
  name,
  defaultValue = "",
  value: controlledValue,
  onValueChange,
  placeholder,
  emptyMessage = "No matches",
  description,
  hideLabel = false,
  className,
}: {
  id: string;
  label: string;
  options: readonly ListOption[];
  name?: string;
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  emptyMessage?: string;
  description?: string;
  hideLabel?: boolean;
  className?: string;
}) {
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
  const value = controlledValue ?? uncontrolledValue;
  const chosen = options.find((option) => option.value === value);
  const [text, setText] = useState(chosen?.label ?? "");
  const [filtering, setFiltering] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const matches = useMemo(() => (filtering ? filterOptions(options, text) : [...options]), [filtering, options, text]);
  const listId = `${id}-listbox`;
  const descriptionId = description ? `${id}-description` : undefined;
  const optionId = (option: ListOption) => `${id}-option-${options.indexOf(option)}`;
  const activeOption = open && active >= 0 ? matches[active] : undefined;

  useEffect(() => {
    if (activeOption) document.getElementById(optionId(activeOption))?.scrollIntoView({ block: "nearest" });
    // optionId only depends on id and options, which activeOption already tracks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOption]);

  const setValue = (next: string) => {
    if (controlledValue === undefined) setUncontrolledValue(next);
    onValueChange?.(next);
  };

  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  const choose = (option: ListOption) => {
    setValue(option.value);
    setText(option.label);
    setFiltering(false);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((current) => nextIndex(open ? current : -1, event.key as "ArrowDown" | "ArrowUp", matches.length, false));
    } else if (event.key === "Enter" && activeOption) {
      event.preventDefault();
      choose(activeOption);
    } else if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        close();
      } else if (text) {
        event.preventDefault();
        setText("");
        setFiltering(false);
        setValue("");
      }
    } else if (event.key === "Tab") {
      close();
    }
  };

  return (
    <div className={cn("relative grid gap-1.5", className)}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : "label-caps text-ink-subtle"}>{label}</label>
      <div className="relative">
        <input
          id={id}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={activeOption ? optionId(activeOption) : undefined}
          aria-describedby={descriptionId}
          value={text}
          placeholder={placeholder}
          className="control pl-3 pr-8"
          onChange={(event) => {
            setText(event.target.value);
            setFiltering(true);
            setOpen(true);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
          onClick={() => setOpen((current) => !current)}
          onBlur={close}
        />
        <Icon name="chevron-down" size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
      </div>
      {name && <input type="hidden" name={name} value={value} />}
      {description && <p id={descriptionId} className="text-caption text-ink-subtle">{description}</p>}
      <div hidden={!open} className="absolute left-0 right-0 top-full z-40 mt-1 rounded-overlay border border-line-strong bg-surface p-1 shadow-popover">
        {/* Pointer choice is handled on the listbox: options never take focus, which stays in the input. */}
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events -- the keyboard equivalent is Enter on the combobox input, per the ARIA combobox pattern */}
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          className="m-0 max-h-64 list-none overflow-y-auto p-0"
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={(event) => {
            const index = optionIndexFrom(event.target);
            if (index >= 0) setActive(index);
          }}
          onClick={(event) => {
            const index = optionIndexFrom(event.target);
            if (index >= 0 && matches[index]) choose(matches[index]);
          }}
        >
          {/* Options exist only while the list is open: a closed list is empty, and 44 hidden companies were 13.9 KiB of the dashboard. */}
          {open && matches.map((option, index) => (
            <li
              key={option.value}
              id={optionId(option)}
              role="option"
              aria-selected={index === active}
              data-index={index}
              className={cn("flex min-h-touch cursor-pointer flex-col justify-center rounded-control px-2.5 py-1 text-xs text-ink", index === active && "bg-surface-selected")}
            >
              <span className="flex items-center gap-2">
                {option.label}
                {option.value === value && <Icon name="check" size={12} className="ml-auto text-accent-ink" label="Chosen" />}
              </span>
              {option.description && <span className="text-caption text-ink-subtle">{option.description}</span>}
            </li>
          ))}
        </ul>
        {matches.length === 0 && <p className="px-2.5 py-3 text-caption text-ink-subtle">{emptyMessage}</p>}
      </div>
      <p role="status" aria-live="polite" className="sr-only">{open ? resultAnnouncement(matches.length, emptyMessage) : ""}</p>
    </div>
  );
}

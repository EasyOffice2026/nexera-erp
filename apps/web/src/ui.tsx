import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

const paths = {
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  book: 'M4 4h13a2 2 0 0 1 2 2v14H6a2 2 0 0 1 0-4h13 M6 16V4 M9 8h6 M9 11h6',
  layers: 'm12 3 9 5-9 5-9-5 9-5Z M3 12l9 5 9-5 M3 16l9 5 9-5',
  chart: 'M3 3v18h18 M8 16v-4 M13 16V7 M18 16v-6',
  building: 'M3 21h18 M6 21V4h12v17 M10 8h.01 M14 8h.01 M10 12h.01 M14 12h.01 M10 21v-5h4v5',
  calendar:
    'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z M7 3v4 M17 3v4 M3 10h18',
  chevron: 'm6 9 6 6 6-6',
  right: 'M5 12h14 m-6-6 6 6-6 6',
  plus: 'M12 5v14 M5 12h14',
  download: 'M12 3v12 m-4-4 4 4 4-4 M4 16v4h16v-4',
  wallet: 'M4 6h15v14H4a2 2 0 0 1-2-2V6l14-3v3 M19 11h-6v4h6 M15 13h.01',
  trend: 'm3 17 6-6 4 4 7-8 M15 7h5v5',
  expense: 'm3 7 6 6 4-4 7 8 M15 17h5v-5',
  coins:
    'M3 7a7 3 0 1 0 14 0A7 3 0 1 0 3 7 M3 7v5c0 2 3 3 7 3 M3 12v5c0 2 3 3 7 3 M13 15a4 2 0 1 0 8 0 4 2 0 1 0-8 0 M13 15v4c0 3 8 3 8 0v-4',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM16 16l4 4',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  close: 'm6 6 12 12 M18 6 6 18',
  check: 'm5 12 4 4L19 6',
} as const;
export type IconName = keyof typeof paths;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

export function Dialog({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? 'wide-dialog' : undefined}
      aria-labelledby={heading}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="dialog-content">
        <div className="dialog-head">
          <h2 id={heading}>{title}</h2>
          <button className="icon-button" onClick={close} aria-label="Close dialog">
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

// A panel of the side columns that folds away under its heading, so the
// column shows what this part uses. Its heading says how many things are in
// it, folded or not.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";

interface Props {
  title: string;
  className?: string;
  testId?: string;
  /** How many things it holds, shown beside the title. */
  count?: number;
  /** Open to begin with. */
  open?: boolean;
  /** Opens by itself when this turns true (a part with nodes, say). */
  autoOpen?: boolean;
  /** Beside the title, on the right: a small action. */
  aside?: ReactNode;
  children: ReactNode;
}

export function Section({ title, className = "", testId, count, open: initial = true, autoOpen, aside, children }: Props) {
  const [open, setOpen] = useState(initial);
  const was = useRef(autoOpen);
  useEffect(() => {
    if (autoOpen && !was.current) setOpen(true);
    was.current = autoOpen;
  }, [autoOpen]);
  const id = (testId ?? title).toLowerCase().replace(/\W+/g, "-");
  return (
    <section className={`panel ${className}${open ? "" : " closed"}`} aria-label={title} data-testid={testId}>
      <h2 className="section-head">
        <button className="section-toggle" aria-expanded={open} aria-controls={`${id}-body`} onClick={() => setOpen((o) => !o)} data-testid={`${id}-toggle`}>
          <Icon name="chevron" size={12} className="chev" />
          {title}
          {count !== undefined && count > 0 && <span className="count">{count}</span>}
        </button>
        {aside && <span className="section-aside">{aside}</span>}
      </h2>
      {open && (
        <div className="section-body" id={`${id}-body`}>
          {children}
        </div>
      )}
    </section>
  );
}

import { useEffect, useRef } from "react";

/**
 * When a form loads its fields, and when a save belongs to a form that is gone.
 *
 * A form is seeded when it opens or is pointed at a different record (`sourceKey`), and again when
 * the record it shows changes underneath it (`sourceSignature`) only if nobody has edited it: a list
 * refresh, or the same record arriving again as a new object, must never wipe what is being typed.
 * Every seeding starts a new session; a save that finishes in an older session says nothing about
 * what is on screen now (`isCurrent`).
 *
 * `seed` loads the fields and must clear the form's dirty baseline. `dirty` is the form's own dirty
 * state. `sourceKey` is null while the form is closed.
 */
export function useFormSeed({
  dirty,
  seed,
  sourceKey,
  sourceSignature
}: {
  dirty: boolean;
  seed: () => void;
  sourceKey: string | null;
  sourceSignature: string;
}) {
  const dirtyRef = useRef(false);
  const seededKey = useRef<string | null>(null);
  const session = useRef(0);
  const seedRef = useRef(seed);
  useEffect(() => {
    dirtyRef.current = dirty;
    seedRef.current = seed;
  });

  useEffect(() => {
    if (sourceKey === null) {
      seededKey.current = null;
      return;
    }
    if (seededKey.current === sourceKey && dirtyRef.current) return;
    seededKey.current = sourceKey;
    session.current += 1;
    seedRef.current();
  }, [sourceKey, sourceSignature]);

  return {
    /** Load the fields again from the record, discarding edits (an explicit discard in place). */
    reseed: () => {
      session.current += 1;
      seedRef.current();
    },
    /** The session a save starts in. */
    current: () => session.current,
    /** Whether a save that started in `startedIn` still belongs to the form on screen. */
    isCurrent: (startedIn: number) => startedIn === session.current
  };
}

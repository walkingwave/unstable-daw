import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// A MIDI track's instrument slot — the device slot, in Ableton terms.
//
// Empty until you load something into it. Swapping the instrument leaves
// the notes untouched, which is the point: the part is the part, and the
// sound is a choice you can change your mind about.
//
// The picker is positioned `fixed` against the viewport rather than
// absolutely against the slot. It has to be: the slot lives inside the
// track header, which is 168px wide and sits in a container with
// `overflow: hidden`, so an absolutely-positioned 250px panel is simply
// clipped away. Fixed positioning escapes every clipping ancestor, at the
// cost of having to place it by hand.

const PANEL_W = 260;
const MAX_H = 300;
const GAP = 4;
const MARGIN = 8; // keep this far clear of the viewport edges

export default function InstrumentSlot({
  instrument,
  instruments,
  onLoad,
  onClear,
  compact,
  loading,
  ready,
}) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState(null);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);

  // Place the panel next to the button, flipping above or below depending
  // on which side has room, and clamping horizontally so it never runs off
  // either edge.
  const place = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();

    const below = window.innerHeight - rect.bottom - GAP - MARGIN;
    const above = rect.top - GAP - MARGIN;
    const openUp = below < 160 && above > below;
    const height = Math.min(MAX_H, Math.max(120, openUp ? above : below));

    const left = Math.min(
      Math.max(MARGIN, rect.left),
      window.innerWidth - PANEL_W - MARGIN,
    );

    setStyle({
      position: 'fixed',
      left,
      width: PANEL_W,
      maxHeight: height,
      ...(openUp
        ? { bottom: window.innerHeight - rect.top + GAP }
        : { top: rect.bottom + GAP }),
    });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;

    const onDown = (e) => {
      if (!buttonRef.current?.contains(e.target) && !panelRef.current?.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    // A fixed panel does not travel with its anchor, so it has to be
    // re-placed on scroll and resize or it detaches from the slot.
    const reposition = () => place();

    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, place]);

  const label = !instrument
    ? 'empty slot'
    : loading
      ? 'loading…'
      : ready
        ? instrument.name
        : `${instrument.name} ·`;

  return (
    <div className={`slot${compact ? ' compact' : ''}`}>
      <button
        ref={buttonRef}
        className={`slot-btn${instrument ? ' loaded' : ''}${
          instrument && loading ? ' busy' : ''
        }`}
        onClick={() => setOpen((v) => !v)}
        title={instrument ? instrument.prompt : 'Load an instrument into this track'}
      >
        {label}
      </button>

      {open && style && (
        <div className="slot-pop" ref={panelRef} style={style}>
          <div className="slot-pop-head">Load instrument</div>
          <div className="slot-pop-list">
            {instruments.length === 0 && (
              <div className="slot-empty">
                No instruments yet — make one on the Instruments tab.
              </div>
            )}
            {instruments.map((i) => (
              <button
                key={i.id}
                className={i.id === instrument?.id ? 'on' : ''}
                onClick={() => {
                  onLoad(i);
                  setOpen(false);
                }}
              >
                <span className="slot-name">{i.name}</span>
                <span className="slot-desc">{i.prompt}</span>
              </button>
            ))}
          </div>
          {instrument && (
            <button
              className="slot-clear"
              onClick={() => {
                onClear();
                setOpen(false);
              }}
            >
              Clear slot
            </button>
          )}
        </div>
      )}
    </div>
  );
}

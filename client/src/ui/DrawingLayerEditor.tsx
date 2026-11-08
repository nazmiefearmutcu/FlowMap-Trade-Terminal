/**
 * The inline text editor of a text drawing. The layer positions it imperatively
 * (the paint loop pins it to its anchor), so it follows the anchor while the
 * chart pans, which a render-time style would not.
 *
 * Enter commits the label; Escape commits a non-empty label and discards an
 * empty one, so an empty label never becomes a drawing; blur commits as well.
 */

import type { RefObject } from 'react';

import { useDrawingsStore } from '../drawings/store';
import type { TextDrawing } from '../drawings/types';
import { useT } from '../i18n/useT';

interface DrawingTextEditorProps {
  /** The text drawing being edited. */
  editing: TextDrawing;
  /** The layer's editor ref; the paint loop positions the element through it. */
  editorRef: RefObject<HTMLInputElement>;
}

export function DrawingTextEditor({ editing, editorRef }: DrawingTextEditorProps): JSX.Element {
  const t = useT();
  return (
    <input
      ref={editorRef}
      className="draw-layer__text-input"
      data-testid="drawing-text-input"
      aria-label={t('drawings.textLabelAria')}
      defaultValue={editing.text}
      maxLength={64}
      autoFocus
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          useDrawingsStore.getState().setText(editing.id, e.currentTarget.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          const v = e.currentTarget.value;
          // Empty label = not a drawing; non-empty = keep, just close.
          if (v === '') useDrawingsStore.getState().setText(editing.id, '');
          else useDrawingsStore.getState().editText(null);
        }
      }}
      onBlur={(e) => {
        const st = useDrawingsStore.getState();
        if (st.editingTextId === editing.id) {
          st.setText(editing.id, e.currentTarget.value);
        }
      }}
    />
  );
}

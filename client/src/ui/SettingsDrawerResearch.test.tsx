import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ResearchContactSection } from './SettingsDrawerResearch';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(secContact: string, onChange = vi.fn()): { onChange: ReturnType<typeof vi.fn> } {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(<ResearchContactSection secContact={secContact} onChange={onChange} />);
  });
  return { onChange };
}

const input = (): HTMLInputElement => document.querySelector<HTMLInputElement>('[data-testid="setting-secContact"]')!;
const invalidMessage = (): HTMLElement | null => document.querySelector('[data-testid="setting-secContact-invalid"]');

/** Types into the controlled input the way a user does (React listens to the native value setter). */
function typeText(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function blur(): void {
  act(() => {
    input().dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

function pressEnter(): void {
  act(() => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('ResearchContactSection', () => {
  it('shows a labelled e-mail input with the stored value and the explanation', () => {
    mount('me@example.com');
    expect(input().type).toBe('email');
    expect(input().getAttribute('autocomplete')).toBe('email');
    expect(input().value).toBe('me@example.com');
    const label = document.querySelector<HTMLLabelElement>('label[for="setting-secContact-input"]');
    expect(label?.textContent).toBe('SEC contact e-mail');
    expect(document.body.textContent).toContain('sec.gov');
    expect(document.body.textContent).toContain('stored on this computer only');
  });

  it('commits a valid address on blur, through onChange', () => {
    const { onChange } = mount('');
    typeText('  analyst@example.com ');
    blur();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ secContact: 'analyst@example.com' });
    expect(invalidMessage()).toBeNull();
  });

  it('commits on Enter as well', () => {
    const { onChange } = mount('');
    typeText('analyst@example.com');
    pressEnter();
    expect(onChange).toHaveBeenCalledWith({ secContact: 'analyst@example.com' });
  });

  it('does not commit an invalid entry and says why', () => {
    const { onChange } = mount('');
    typeText('analyst@example');
    blur();
    expect(onChange).not.toHaveBeenCalled();
    expect(invalidMessage()?.textContent).toBe('Enter an e-mail address such as name@example.com, or leave the field empty.');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(input().value).toBe('analyst@example');
  });

  it('clears the stored contact when the entry is emptied', () => {
    const { onChange } = mount('me@example.com');
    typeText('');
    blur();
    expect(onChange).toHaveBeenCalledWith({ secContact: '' });
  });

  it('does not commit when the value did not change', () => {
    const { onChange } = mount('me@example.com');
    blur();
    pressEnter();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('follows a value changed elsewhere, such as restore defaults', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container!);
      root.render(<ResearchContactSection secContact="me@example.com" onChange={vi.fn()} />);
    });
    act(() => {
      root!.render(<ResearchContactSection secContact="" onChange={vi.fn()} />);
    });
    expect(input().value).toBe('');
  });
});

export const UI_STYLE_ATTRIBUTE = 'data-ui-style';
export const UI_STYLE = 'terminal';
export const UI_STYLES = [UI_STYLE, 'pixel'] as const;
export type UiStyle = typeof UI_STYLES[number];

export function applyUiStyle(style: UiStyle): void {
  document.documentElement.setAttribute(UI_STYLE_ATTRIBUTE, style);
}

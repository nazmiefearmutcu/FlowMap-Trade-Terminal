/**
 * Licence texts for the bundled UI fonts (SIL Open Font License 1.1).
 *
 * The texts are imported as raw strings, so any consumer that renders FONT_LICENSES
 * (the About panel) carries them in the web bundle next to the fonts they cover.
 * Nothing is embedded for a module that is never imported. Consumers render `text`
 * as-is.
 */
import interLicense from '../assets/fonts/LICENSE-inter.txt?raw';
import jetbrainsMonoLicense from '../assets/fonts/LICENSE-jetbrains-mono.txt?raw';

export interface FontLicense {
  /** CSS family name the font is registered under in fonts.css. */
  readonly family: string;
  /** Licence name, as stated in the licence text. */
  readonly license: string;
  /** Full licence text, copyright lines included. */
  readonly text: string;
}

export const FONT_LICENSES: readonly FontLicense[] = [
  { family: 'Inter', license: 'SIL Open Font License 1.1', text: interLicense },
  { family: 'JetBrains Mono', license: 'SIL Open Font License 1.1', text: jetbrainsMonoLicense },
];

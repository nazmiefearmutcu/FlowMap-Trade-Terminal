/** The market and symbol the app shows before anything is subscribed: the simulated feed. */
export const SIM_MARKET = 'sim';
export const SIM_SYMBOL = 'SIM-DEMO';

/** Element id linking the chart canvas to its keyboard reference (aria-describedby). */
export const CHART_HELP_ID = 'gl-canvas-help';

/**
 * The i18n key of the chart's keyboard reference. The bare-key sentence is named
 * only while single-key shortcuts are on, so a screen-reader user is not told
 * about keys that do nothing.
 */
export function chartHelpKey(singleKeys: boolean): string {
  return singleKeys ? 'chart.ariaHelp' : 'chart.ariaHelpNoKey';
}

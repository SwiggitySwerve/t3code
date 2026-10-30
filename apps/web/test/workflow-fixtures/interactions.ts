import { userEvent } from "vite-plus/test/browser";
import type { render } from "../render";

/** Opens the receipt and every phase disclosure; returns how many buttons were clicked. */
export async function expandWorkflowPhases(
  screen: Awaited<ReturnType<typeof render>>,
  click: (button: HTMLButtonElement) => Promise<unknown> = (button) => userEvent.click(button),
): Promise<number> {
  let clicks = 0;
  const receipt = screen.container.querySelector<HTMLButtonElement>(
    '[data-workflow-receipt] button[aria-expanded="false"]',
  );
  if (receipt) {
    await click(receipt);
    clicks += 1;
  }
  for (const button of screen.container.querySelectorAll<HTMLButtonElement>(
    '[data-workflow-phase-disclosure][aria-expanded="false"]',
  )) {
    await click(button);
    clicks += 1;
  }
  return clicks;
}

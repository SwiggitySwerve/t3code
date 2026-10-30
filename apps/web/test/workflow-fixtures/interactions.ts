import { userEvent } from "vite-plus/test/browser";
import type { render } from "../render";

export async function expandWorkflowPhases(screen: Awaited<ReturnType<typeof render>>) {
  const receipt = screen.container.querySelector<HTMLButtonElement>(
    '[data-workflow-receipt] button[aria-expanded="false"]',
  );
  if (receipt) await userEvent.click(receipt);
  for (const button of screen.container.querySelectorAll<HTMLButtonElement>(
    '[data-workflow-phase-disclosure][aria-expanded="false"]',
  ))
    await userEvent.click(button);
}

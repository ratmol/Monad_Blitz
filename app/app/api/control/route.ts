import {NextResponse} from "next/server";

import {runtime} from "../../../lib/agent/runtime";

/**
 * Start, stop, and reset-learning for the agent.
 *
 * Note what is *not* here: no deposit, no withdraw, no weight override. Those are
 * owner powers and they live on-chain behind `onlyOwner`. A dashboard button that
 * moved funds would undercut the entire pitch — the point is that this process
 * cannot, and there is no code path here that pretends otherwise.
 */
export const dynamic = "force-dynamic";

type Action = "start" | "stop" | "reset";

export async function POST(request: Request) {
  let action: Action;
  try {
    ({action} = (await request.json()) as {action: Action});
  } catch {
    return NextResponse.json({error: "expected a JSON body with an action"}, {status: 400});
  }

  const {loop} = runtime();

  switch (action) {
    case "start":
      loop.start();
      break;
    case "stop":
      loop.stop();
      break;
    case "reset":
      // Wipes the estimates and the chart. Deliberately does not touch the book:
      // the vault's value is real on-chain state and this process does not get to
      // rewrite it. This is the "show me it learning from scratch" button.
      loop.resetLearning();
      break;
    default:
      return NextResponse.json({error: `unknown action: ${String(action)}`}, {status: 400});
  }

  return NextResponse.json({running: loop.isRunning, action});
}

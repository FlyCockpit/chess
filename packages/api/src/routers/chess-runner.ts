import { protectedProcedure } from "../index";
import {
  createRunnerInput,
  createRunnerMatch,
  runnerCommandInput,
  runnerMatchStatus,
  runnerSlugInput,
  startRunnerMatch,
  stopRunnerMatch,
} from "../lib/chess-runner";
import { createProcedureBudget } from "../lib/procedure-budget";

const controlBudget = createProcedureBudget({
  keyPrefix: "chess:runner-control",
  points: 120,
  durationSeconds: 60,
  failClosed: true,
  overBudgetMessage: () => "Runner control allowance exceeded",
  unavailableMessage: "Runner controls unavailable",
  unavailableLog: "[chess] Runner control budget unavailable",
});

/** Cookie surface only; the helper rechecks live browser authority under reset's lock. */
export const chessRunnerRouter = {
  createRunner: protectedProcedure.input(createRunnerInput).handler(async ({ context, input }) => {
    await controlBudget(context.session.user.id);
    return createRunnerMatch(context, input);
  }),
  startRunner: protectedProcedure.input(runnerCommandInput).handler(async ({ context, input }) => {
    await controlBudget(context.session.user.id);
    return startRunnerMatch(context, input);
  }),
  stopRunner: protectedProcedure.input(runnerCommandInput).handler(async ({ context, input }) => {
    await controlBudget(context.session.user.id);
    return stopRunnerMatch(context, input);
  }),
  runnerStatus: protectedProcedure
    .input(runnerSlugInput)
    .handler(({ context, input }) => runnerMatchStatus(context, input)),
};

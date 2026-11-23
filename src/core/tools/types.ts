// What a tool looks like. Every capability of the agent (calendar, mail, ...)
// is one object of this shape.

export type Tool = {
  // The name the model uses to call the tool.
  name: string;
  // Tells the model what the tool does and when to use it.
  description: string;
  // JSON Schema of the arguments the model must send.
  parameters: Record<string, unknown>;
  // The actual code. Gets the arguments, returns a result the model can read.
  run: (args: Record<string, unknown>) => Promise<unknown>;

  // Runs before anything else and returns the final arguments, with every
  // open choice settled (for example: which account). The approval text and the
  // action itself both use this same result, so what the user approves is
  // exactly what happens.
  prepare?: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

  // PERMISSIONS. A tool that changes something in the world (creates, sends,
  // deletes) sets needsApproval. The agent then stops and asks the user before
  // running it. The model cannot skip this: the check is in our code.
  needsApproval?: boolean;
  // One short sentence, in Hebrew, telling the user exactly what will happen.
  // Required when needsApproval is set.
  describe?: (args: Record<string, unknown>) => string;
};

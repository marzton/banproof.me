export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  env!: Env;
  async run(_event: { payload: Params }, _step: unknown): Promise<unknown> {
    throw new Error('Not implemented in shim');
  }
}

export type WorkflowEvent<T> = { payload: T };
export type WorkflowStep = {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
};

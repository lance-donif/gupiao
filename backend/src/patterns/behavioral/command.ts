export interface ICommandResult<TState> {
  readonly success: boolean;
  readonly snapshot: TState;
}

export interface ICommand<TState> {
  execute: () => ICommandResult<TState>;
  undo: () => ICommandResult<TState>;
}

export class TaskBoard {
  private readonly tasks: string[];

  public constructor(initialTasks: readonly string[] = []) {
    this.tasks = [...initialTasks];
  }

  public addTask(task: string): void {
    this.tasks.push(task);
  }

  public replaceTasks(tasks: readonly string[]): void {
    this.tasks.splice(0, this.tasks.length, ...tasks);
  }

  public snapshot(): readonly string[] {
    return [...this.tasks];
  }
}

export class AppendTaskCommand implements ICommand<readonly string[]> {
  private previousState: readonly string[] | null = null;

  public constructor(
    private readonly board: TaskBoard,
    private readonly task: string,
  ) {}

  public execute(): ICommandResult<readonly string[]> {
    this.previousState = this.board.snapshot();
    this.board.addTask(this.task);

    return {
      success: true,
      snapshot: this.board.snapshot(),
    };
  }

  public undo(): ICommandResult<readonly string[]> {
    if (!this.previousState) {
      throw new Error('Cannot undo before execute.');
    }

    this.board.replaceTasks(this.previousState);

    return {
      success: true,
      snapshot: this.board.snapshot(),
    };
  }
}

export interface IObserver<TEvent> {
  update: (event: TEvent) => void;
}

export class EventSubject<TEvent> {
  private readonly observers = new Set<IObserver<TEvent>>();

  public subscribe(observer: IObserver<TEvent>): void {
    this.observers.add(observer);
  }

  public unsubscribe(observer: IObserver<TEvent>): void {
    this.observers.delete(observer);
  }

  public notify(event: TEvent): void {
    for (const observer of this.observers) {
      observer.update(event);
    }
  }
}

export class EventRecorder<TEvent> implements IObserver<TEvent> {
  private readonly events: TEvent[] = [];

  public update(event: TEvent): void {
    this.events.push(event);
  }

  public getEvents(): readonly TEvent[] {
    return [...this.events];
  }
}

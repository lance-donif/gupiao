export abstract class BaseValueObject<TValue> {
  protected constructor(protected readonly value: TValue) {
    Object.freeze(this);
  }

  public equals(other: BaseValueObject<TValue>): boolean {
    return this.value === other.value;
  }
}

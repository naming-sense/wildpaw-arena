export class RingBuffer<T> {
  private readonly values: T[] = [];

  constructor(private readonly capacity: number) {}

  push(value: T): void {
    this.values.push(value);
    if (this.values.length > this.capacity) {
      this.values.shift();
    }
  }

  toArray(): T[] {
    return [...this.values];
  }

  retain(predicate: (value: T) => boolean): void {
    for (let i = this.values.length - 1; i >= 0; i -= 1) {
      if (!predicate(this.values[i])) {
        this.values.splice(i, 1);
      }
    }
  }

  last(): T | undefined {
    return this.values[this.values.length - 1];
  }
}

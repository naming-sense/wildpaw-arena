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

  clear(): void {
    this.values.length = 0;
  }
}

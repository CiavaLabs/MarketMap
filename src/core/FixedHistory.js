export class FixedHistory {
  constructor(capacity = 50, initialValues = []) {
    this.capacity = Math.max(1, Number(capacity) || 1);
    this.buffer = new Array(this.capacity);
    this.start = 0;
    this.length = 0;
    initialValues.forEach((value) => this.push(value));
  }

  push(value) {
    if (this.length < this.capacity) {
      this.buffer[(this.start + this.length) % this.capacity] = value;
      this.length += 1;
    } else {
      this.buffer[this.start] = value;
      this.start = (this.start + 1) % this.capacity;
    }
    return this.length;
  }

  toArray() {
    return Array.from({ length: this.length }, (_, index) =>
      this.buffer[(this.start + index) % this.capacity],
    );
  }

  clear() {
    this.buffer = new Array(this.capacity);
    this.start = 0;
    this.length = 0;
  }
}

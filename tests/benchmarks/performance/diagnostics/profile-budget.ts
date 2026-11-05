const MIB = 1024 * 1024;
const SEGMENT_LIMIT = 64 * MIB;
const RUN_LIMIT = 512 * MIB;

export class ProfileBudget {
  #bytesReserved = 0;
  #profilesMissing = 0;

  reserve(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > SEGMENT_LIMIT || this.#bytesReserved + bytes > RUN_LIMIT) {
      this.#profilesMissing += 1;
      return false;
    }
    this.#bytesReserved += bytes;
    return true;
  }

  snapshot(): Readonly<{ bytesReserved: number; profilesMissing: number }> {
    return Object.freeze({ bytesReserved: this.#bytesReserved, profilesMissing: this.#profilesMissing });
  }
}

export class SessionAttemptGate {
	#generation = 0;
	#active = false;

	begin(): number | undefined {
		if (this.#active) return undefined;
		this.#active = true;
		return ++this.#generation;
	}

	invalidate(): void {
		this.#active = false;
		this.#generation++;
	}

	isCurrent(generation: number): boolean {
		return this.#active && this.#generation === generation;
	}

	finish(generation: number): void {
		if (this.#generation === generation) this.#active = false;
	}
}

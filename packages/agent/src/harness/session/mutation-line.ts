/** A scope owned by one serialized durable session mutation. */
export class MutationScope {
	mutate<T>(_operation: () => T | Promise<T>): never {
		throw new Error("Nested durable session mutations are not allowed");
	}

	externalEffect(kind: string): never {
		throw new Error(`External effect "${kind}" is not allowed inside a durable session mutation`);
	}
}

/** Serializes complete read-decide-write jobs for one Session. */
export class MutationLine {
	private tail: Promise<void> = Promise.resolve();
	private sealedError: Error | undefined;

	run<T>(operation: (scope: MutationScope) => T | Promise<T>): Promise<T> {
		if (this.sealedError !== undefined) return Promise.reject(this.sealedError);
		const result = this.tail.then(() => {
			if (this.sealedError !== undefined) throw this.sealedError;
			return operation(new MutationScope());
		});
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	seal(error: Error): Promise<void> {
		this.sealedError ??= error;
		return this.tail;
	}
}

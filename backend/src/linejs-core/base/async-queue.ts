/**
 * Runs async tasks one at a time, in the order they were queued.
 *
 * Exists for state two independent callers both read, mutate, and write
 * back without any lock — queuing every task through one instance is what
 * makes "read old value, do work, write new value" atomic across callers
 * that have no other way to know about each other.
 */
export class AsyncQueue {
	#tail: Promise<void> = Promise.resolve();

	/**
	 * Runs `task` after every previously queued task has settled (whether
	 * those succeeded or failed), and returns its own result or rejection.
	 *
	 * One task throwing does not jam the queue: the queue's own internal
	 * chain always continues, but the promise returned to *this* caller
	 * still rejects, so `run`'s errors are never silently swallowed.
	 */
	run<T>(task: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(task, task);
		this.#tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}
}

/**
 * Back and forward through the places the cursor has been, across files, as
 * in VS Code: a jump (go to definition, a reference, another tab, a click far
 * away) leaves a mark; moving within a few lines only updates the current
 * mark. Pure bookkeeping: the dock records and acts on what this returns.
 */

/** A place in a project file; line and column are 1-based, as in Monaco. */
export interface Place {
	path: string;
	line: number;
	column: number;
}

/** Moves of fewer lines than this within one file update the current mark instead of adding one. */
const NEARBY_LINES = 10;
/** Marks kept; older ones are dropped. */
const LIMIT = 50;

export class NavigationHistory {
	private places: Place[] = [];
	private index = -1;

	/** Notes that the cursor is now at `place`. */
	record(place: Place): void {
		const current = this.places[this.index];
		if (current && current.path === place.path && Math.abs(current.line - place.line) < NEARBY_LINES) {
			this.places[this.index] = place;
			return;
		}
		this.places.splice(this.index + 1, Infinity, place);
		if (this.places.length > LIMIT) this.places.shift();
		this.index = this.places.length - 1;
	}

	/**
	 * The place to go back to, skipping places for which `exists` is false
	 * (a deleted file), or `null` at the start. The caller then goes there;
	 * recording that place again does not add a mark.
	 */
	back(exists: (path: string) => boolean): Place | null {
		return this.step(-1, exists);
	}

	/** The place to go forward to, as `back`. */
	forward(exists: (path: string) => boolean): Place | null {
		return this.step(1, exists);
	}

	/** Forgets everything, as when the project is replaced. */
	clear(): void {
		this.places = [];
		this.index = -1;
	}

	private step(direction: -1 | 1, exists: (path: string) => boolean): Place | null {
		for (let i = this.index + direction; i >= 0 && i < this.places.length; i += direction) {
			const place = this.places[i];
			if (place && exists(place.path)) {
				this.index = i;
				return place;
			}
		}
		return null;
	}
}

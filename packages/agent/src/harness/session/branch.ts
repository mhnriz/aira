import type { AgentMessage } from "../../types.ts";
import type { Session } from "./session.ts";
import type { Branch, BranchBounds, Entry, EntryQuery } from "./types.ts";

/** Path-only view over one named branch. Global session state is unavailable here. */
export class SessionBranch implements Branch {
	readonly name: string;
	private readonly session: Session;

	constructor(session: Session, name: string) {
		this.session = session;
		this.name = name;
	}

	getTipId(): Promise<string | null> {
		return this.session.getTipId(this.name);
	}

	getEntry(id: string): Promise<Entry | undefined> {
		return this.session.getEntry(id);
	}

	findEntries(query: EntryQuery & BranchBounds = {}): Promise<Entry[]> {
		return this.session.findEntriesOnBranchFor(this.name, query);
	}

	async findEntry(query: EntryQuery & BranchBounds = {}): Promise<Entry | undefined> {
		return this.session.findEntryOnBranchFor(this.name, query);
	}

	appendMessage(message: AgentMessage): Promise<string> {
		return this.session.appendMessageTo(this.name, message);
	}

	appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		return this.session.appendCustomEntryTo(this.name, customType, data);
	}
}

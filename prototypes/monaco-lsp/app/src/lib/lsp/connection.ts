/**
 * JSON-RPC 2.0 over a Web Worker's `postMessage`, one message object per
 * post, as `packs/CONTRACT.md` specifies. Nothing here knows about LSP
 * beyond the error codes; `client.ts` gives the methods meaning.
 */

/** A JSON-RPC request or notification as it travels; `id` absent for a notification. */
interface RequestMessage {
	jsonrpc: '2.0';
	id?: number | string;
	method: string;
	params?: unknown;
}

/** A JSON-RPC response; exactly one of `result` and `error` is meaningful. */
interface ResponseMessage {
	jsonrpc: '2.0';
	id: number | string | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

/** Handles a request from the server; the value it resolves to is the result. */
export type RequestHandler = (params: unknown) => unknown;
/** Handles a notification from the server. */
export type NotificationHandler = (params: unknown) => void;

/** The JSON-RPC error a server returns; `code` is from the LSP/JSON-RPC tables. */
export class ResponseError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
	}
}

/** JSON-RPC's "method not found", returned for server requests nobody handles. */
const METHOD_NOT_FOUND = -32601;
/** LSP's "request cancelled", which callers treat as an empty answer, not a failure. */
export const REQUEST_CANCELLED = -32800;

/**
 * One connection to one worker. Ordering is the caller's business: the LSP
 * client sends nothing but `initialize` until that has been answered.
 */
export class Connection {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private readonly requestHandlers = new Map<string, RequestHandler>();
	private readonly notificationHandlers = new Map<string, NotificationHandler>();
	private closed: Error | null = null;

	/**
	 * @param worker the server; owned by the connection from now on and
	 *   terminated by {@link Connection.dispose}.
	 * @param onClose called once when the worker dies or is disposed, with
	 *   the reason when it died on its own.
	 */
	/**
	 * @param trace when given, called with every message in both directions,
	 *   for the `?trace` debugging mode.
	 */
	constructor(
		private readonly worker: Worker,
		private readonly onClose: (error: Error | null) => void,
		private readonly trace?: (direction: 'send' | 'receive', message: unknown) => void,
	) {
		worker.onmessage = (e: MessageEvent<unknown>) => {
			this.trace?.('receive', e.data);
			this.receive(e.data);
		};
		worker.onerror = (e: ErrorEvent) => {
			e.preventDefault();
			this.close(new Error(e.message || 'the language server failed to start'));
		};
		worker.onmessageerror = () => this.close(new Error('the language server sent a message that cannot be read'));
	}

	/** Registers the handler for a request the server sends; one per method. */
	onRequest(method: string, handler: RequestHandler): void {
		this.requestHandlers.set(method, handler);
	}

	/** Registers the handler for a notification the server sends; one per method. */
	onNotification(method: string, handler: NotificationHandler): void {
		this.notificationHandlers.set(method, handler);
	}

	/**
	 * Sends a request. Rejects with {@link ResponseError} when the server
	 * answers with an error, and with a plain `Error` when the connection
	 * closes first. `signal` sends `$/cancelRequest` and rejects with a
	 * {@link ResponseError} whose code is {@link REQUEST_CANCELLED}.
	 */
	request<R>(method: string, params: unknown, signal?: AbortSignal): Promise<R> {
		if (this.closed) return Promise.reject(this.closed);
		const id = this.nextId++;
		return new Promise<R>((resolve, reject) => {
			const settle = () => signal?.removeEventListener('abort', abort);
			const abort = () => {
				if (!this.pending.delete(id)) return;
				this.post({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
				reject(new ResponseError(REQUEST_CANCELLED, 'cancelled'));
			};
			this.pending.set(id, {
				resolve: (v) => (settle(), resolve(v as R)),
				reject: (e) => (settle(), reject(e)),
			});
			signal?.addEventListener('abort', abort, { once: true });
			this.post({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) });
		});
	}

	/** Sends a notification; dropped silently once the connection has closed. */
	notify(method: string, params: unknown): void {
		// JSON-RPC allows params to be absent but not null.
		if (!this.closed) this.post({ jsonrpc: '2.0', method, ...(params !== undefined && { params }) });
	}

	/** Terminates the worker and fails every pending request. Idempotent. */
	dispose(): void {
		this.close(null);
	}

	private post(message: RequestMessage | ResponseMessage): void {
		this.trace?.('send', message);
		this.worker.postMessage(message);
	}

	private close(error: Error | null): void {
		if (this.closed) return;
		this.closed = error ?? new Error('the language server was stopped');
		this.worker.terminate();
		for (const p of this.pending.values()) p.reject(this.closed);
		this.pending.clear();
		this.onClose(error);
	}

	private receive(data: unknown): void {
		if (typeof data !== 'object' || data === null) return;
		const message = data as Partial<RequestMessage & ResponseMessage>;
		if (typeof message.method === 'string') {
			if (message.id === undefined) this.notificationHandlers.get(message.method)?.(message.params);
			else void this.answer(message.id, message.method, message.params);
		} else if (typeof message.id === 'number') {
			const p = this.pending.get(message.id);
			if (!p) return; // answer to a request we cancelled
			this.pending.delete(message.id);
			if (message.error) p.reject(new ResponseError(message.error.code, message.error.message, message.error.data));
			else p.resolve(message.result ?? null);
		}
	}

	private async answer(id: number | string, method: string, params: unknown): Promise<void> {
		const handler = this.requestHandlers.get(method);
		if (!handler) {
			this.post({ jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `unhandled method ${method}` } });
			return;
		}
		try {
			this.post({ jsonrpc: '2.0', id, result: (await handler(params)) ?? null });
		} catch (e) {
			const code = e instanceof ResponseError ? e.code : -32603;
			this.post({ jsonrpc: '2.0', id, error: { code, message: e instanceof Error ? e.message : String(e) } });
		}
	}
}

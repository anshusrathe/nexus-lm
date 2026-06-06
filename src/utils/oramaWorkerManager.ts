import OramaWorker from 'web-worker:../workers/oramaWorker';

export interface OramaRequest {
    type: 'INIT' | 'SEARCH' | 'INSERT' | 'INSERT_BATCH' | 'SAVE' | 'LOAD' | 'REMOVE' | 'CLEAR' | 'CLEAR_FILE' | 'GET_METADATA';
    instanceId: string;
    payload?: any;
}

export interface OramaResponse {
    success: boolean;
    instanceId: string;
    payload?: any;
    error?: string;
}

export class OramaWorkerManager {
    private static instance: OramaWorkerManager;
    private worker: Worker | null = null;
    private pendingRequests: Map<string, { resolve: Function, reject: Function }> = new Map();

    private constructor() {}

    public static getInstance(): OramaWorkerManager {
        if (!OramaWorkerManager.instance) {
            OramaWorkerManager.instance = new OramaWorkerManager();
        }
        return OramaWorkerManager.instance;
    }

    private initWorker() {
        if (this.worker) return;

                this.worker = new OramaWorker();
        this.worker.onmessage = (event: MessageEvent<OramaResponse & { id: string }>) => {
            const { id, success, error, payload } = event.data;
            const pending = this.pendingRequests.get(id);
            if (pending) {
                if (success) {
                    pending.resolve(payload);
                } else {
                    pending.reject(new Error(error || 'Worker operation failed'));
                }
                this.pendingRequests.delete(id);
            }
        };

        this.worker.onerror = (error) => {
                        // On catastrophic error, reject all pending and reset
            this.pendingRequests.forEach(p => p.reject(error));
            this.pendingRequests.clear();
            this.worker?.terminate();
            this.worker = null;
        };
    }

    private sendRequest(request: OramaRequest, transferables: Transferable[] = []): Promise<any> {
        this.initWorker();
        const requestId = Math.random().toString(36).substring(2, 10);
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(requestId, { resolve, reject });
            this.worker!.postMessage({ ...request, id: requestId }, transferables);
        });
    }

    public async init(instanceId: string, schema: any, metadata?: any): Promise<void> {
        await this.sendRequest({ type: 'INIT', instanceId, payload: { schema, metadata } });
    }

    public async load(instanceId: string, data: ArrayBuffer, schema: any, compressed: boolean = true): Promise<any> {
        return await this.sendRequest({ 
            type: 'LOAD', 
            instanceId, 
            payload: { data, schema, compressed } 
        }, [data]);
    }

    public async save(instanceId: string, compress: boolean = true, metadata?: any, documents?: any[]): Promise<{ data: Uint8Array | string, compressed: boolean, metadata?: any }> {
        return await this.sendRequest({ type: 'SAVE', instanceId, payload: { compress, metadata, documents } });
    }

    public async insert(instanceId: string, document: any): Promise<void> {
        await this.sendRequest({ type: 'INSERT', instanceId, payload: { document } });
    }

    public async insertBatch(instanceId: string, documents: any[]): Promise<void> {
        await this.sendRequest({ type: 'INSERT_BATCH', instanceId, payload: { documents } });
    }

    public async search(instanceId: string, params: any): Promise<any> {
        return await this.sendRequest({ type: 'SEARCH', instanceId, payload: { params } });
    }

    public async remove(instanceId: string, docId: string): Promise<void> {
        await this.sendRequest({ type: 'REMOVE', instanceId, payload: { docId } });
    }

    public async clear(instanceId: string): Promise<void> {
        await this.sendRequest({ type: 'CLEAR', instanceId });
    }

    public async clearFile(instanceId: string, path: string): Promise<void> {
        await this.sendRequest({ type: 'CLEAR_FILE', instanceId, payload: { path } });
    }

    public async getMetadata(instanceId: string): Promise<any> {
        return await this.sendRequest({ type: 'GET_METADATA', instanceId });
    }

    public terminate() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
    }
}

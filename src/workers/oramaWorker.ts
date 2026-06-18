import { create, insert, search, save, load, remove, AnyOrama, AnySchema } from '@orama/orama';
import * as fflate from 'fflate';
import { decode } from '@msgpack/msgpack';

interface ShadowDoc {
    path: string;
    chunkIndex: number;
    lastModified: number;
    hasEmbedding: boolean;
    content: string;
}

interface LegacyDoc {
    path: string;
    chunkIndex: number;
    content: string;
    lastModified: number;
    embedding?: number[];
    metadata?: {
        title?: string;
        headings?: string[];
        tags?: string[];
    };
}

interface DecodedLoadPayload {
    type?: string;
    metadata?: OramaMetadata;
    state?: unknown;
    documents?: LegacyDoc[];
    lastUpdated?: number;
    model?: string;
}

interface OramaWorkerMessage {
    type: 'INIT' | 'SEARCH' | 'INSERT' | 'INSERT_BATCH' | 'SAVE' | 'LOAD' | 'REMOVE' | 'CLEAR' | 'CLEAR_FILE' | 'GET_METADATA';
    instanceId: string;
    id?: string;
    payload?: OramaWorkerPayload;
}

interface OramaWorkerResponse {
    success: boolean;
    instanceId: string;
    id?: string;
    payload?: unknown;
    error?: string;
}

interface OramaMetadata {
    dimension?: number;
    documents?: ShadowDoc[];
    lastUpdated?: number;
    version?: number;
    model?: string;
}

interface OramaSavePayload {
    metadata?: Record<string, unknown>;
    documents?: Array<Record<string, unknown>>;
    compress?: boolean;
}

interface OramaSearchParams {
    mode?: string;
    vector?: { value?: number[] } | number[];
    term?: string;
}

interface OramaSearchPayload {
    mode?: string;
    vector?: { value?: number[] } | number[];
    params?: OramaSearchParams;
}

interface OramaInsertPayload {
    documents?: Array<Record<string, unknown>>;
}

interface OramaRemovePayload {
    docId?: string;
    path?: string;
}

const ctx: Worker = self as unknown as Worker;
const instances: Map<string, AnyOrama> = new Map();
const schemas: Map<string, AnySchema> = new Map();
const metadatas: Map<string, OramaMetadata> = new Map();
const shadowDocsMap: Map<string, ShadowDoc[]> = new Map();

const tokenizerConfig = {
    allowDuplicates: true,
    stemming: true,
    stopWords: [
        'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
        'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
        'will', 'would', 'can', 'could', 'shall', 'should', 'may', 'might',
        'must', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'as',
        'from', 'into', 'through', 'during', 'before', 'after', 'above',
        'below', 'up', 'down', 'this', 'that', 'these', 'those', 'it',
        'its', 'they', 'them', 'their', 'he', 'she', 'his', 'her', 'him',
        'we', 'us', 'our', 'you', 'your', 'i', 'me', 'my', 'not', 'no',
        'nor', 'so', 'such', 'very', 'just', 'own', 'then', 'than'
    ]
};

function createDb(schema: AnySchema) {
    return create({ schema, components: { tokenizer: tokenizerConfig } });
}


function buildSchema(dimension: number = 0) {
    const schema: Record<string, string> = {
        id: 'string',
        path: 'string',
        chunkIndex: 'number',
        title: 'string',
        headings: 'string',
        tags: 'string',
        content: 'string',
        lastModified: 'number'
    };
    if (dimension > 0) schema.embedding = `vector[${dimension}]`;
    return schema as AnySchema;
}

async function initInstance(instanceId: string, schema: AnySchema) {
    try {
        const db = await createDb(schema);
        instances.set(instanceId, db);
        schemas.set(instanceId, schema);
        shadowDocsMap.set(instanceId, []);
        return db;
    } catch (e) {
                throw e;
    }
}

ctx.addEventListener('message', (event: MessageEvent<OramaWorkerMessage>) => {
    void (async () => {
        const { type, instanceId, id, payload } = event.data;
        let db = instances.get(instanceId);

        try {
            switch (type) {
            case 'INIT':
                if (!payload) throw new Error('Missing payload for INIT');
                await initInstance(instanceId, payload.schema as AnySchema);
                metadatas.set(instanceId, (payload.metadata || {}) as OramaMetadata);
                ctx.postMessage({ success: true, instanceId, id });
                break;

            case 'LOAD':
                if (!payload) throw new Error('Missing payload for LOAD');
                try {
                    let binaryData: ArrayBuffer | Array<Record<string, unknown>> | undefined = payload.data as unknown as ArrayBuffer | Array<Record<string, unknown>>;
                    if (payload.compressed) binaryData = fflate.unzlibSync(new Uint8Array(binaryData as ArrayBuffer));
                    
                    let decoded: DecodedLoadPayload;
                    
                    // Format Detection: Check if it starts with '{' (JSON) or something else (MsgPack)
                    const binaryView = new Uint8Array(binaryData as ArrayBuffer);
                    const firstByte = binaryView[0];
                    if (firstByte === 123) { // '{' character
                                                decoded = JSON.parse(new TextDecoder().decode(binaryData as ArrayBuffer)) as DecodedLoadPayload;
                    } else {
                                                decoded = decode(binaryData as ArrayBuffer) as DecodedLoadPayload;
                    }
                    
                    let shadowDocs: ShadowDoc[] = [];
                    
                    if (decoded.type === 'orama-state') {
                        // NEW Container format
                        const metadata = (decoded.metadata || {}) as OramaMetadata;
                        const dimension = metadata.dimension || 0;
                        const schema = buildSchema(dimension);
                        
                        const newDb = await createDb(schema);
                        await load(newDb, decoded.state as Parameters<typeof load>[1]);
                        
                        instances.set(instanceId, newDb);
                        schemas.set(instanceId, schema);
                        metadatas.set(instanceId, metadata);
                        
                        shadowDocs = metadata.documents || [];
                        shadowDocsMap.set(instanceId, shadowDocs);
                    } else if (decoded.documents && Array.isArray(decoded.documents)) {
                        // Migration from old SearchIndex
                        const docs = decoded.documents as LegacyDoc[];
                        let dim = 0;
                        for (const d of docs) {
                            if (d.embedding && d.embedding.length > 0) { dim = d.embedding.length; break; }
                        }
                        
                        const schema = buildSchema(dim);
                        const newDb = await initInstance(instanceId, schema);
                        
                        shadowDocs = [];
                        for (const doc of docs) {
                            const meta = doc.metadata || {};
                            const oramaDoc: Record<string, unknown> = {
                                id: `${doc.path}:${doc.chunkIndex}`,
                                path: doc.path,
                                chunkIndex: doc.chunkIndex,
                                title: meta.title || '',
                                headings: (meta.headings || []).join(' '),
                                tags: (meta.tags || []).join(' '),
                                body: doc.content || '',
                                content: doc.content || '',
                                lastModified: doc.lastModified || 0
                            };
                            if (dim > 0) oramaDoc.embedding = (doc.embedding?.length === dim) ? doc.embedding : new Array(dim).fill(0);
                            await insert(newDb, oramaDoc);
                            
                            shadowDocs.push({
                                path: doc.path,
                                chunkIndex: doc.chunkIndex,
                                lastModified: doc.lastModified || 0,
                                hasEmbedding: doc.embedding != null && doc.embedding.length > 0,
                                content: doc.content || ''
                            });
                        }
                        
                        metadatas.set(instanceId, {
                            lastUpdated: Number(decoded.lastUpdated || Date.now()),
                            version: 6,
                            model: String(decoded.model || ''),
                            dimension: dim
                        });
                        shadowDocsMap.set(instanceId, shadowDocs);
                    }
                    
                    ctx.postMessage({ 
                        success: true, instanceId, id, 
                        payload: { metadata: metadatas.get(instanceId), documents: shadowDocs } 
                    });
                } catch (e: unknown) {
                                        throw new Error(`Load failed: ${e instanceof Error ? e.message : String(e)}`);
                }
                break;

            case 'SAVE':
                if (!db) throw new Error(`Instance not found`);
                if (!payload) throw new Error('Missing payload for SAVE');
                const state = await save(db);
                const savePayload = payload as unknown as OramaSavePayload;
                const metadata: OramaMetadata = { ...(savePayload.metadata || metadatas.get(instanceId) || {}) } as OramaMetadata;
                
                // Track dimension
                const currentSchema: AnySchema = schemas.get(instanceId)!;
                if ((currentSchema as unknown as Record<string, unknown>)?.embedding) {
                    const match = String((currentSchema as unknown as Record<string, unknown>).embedding).match(/vector\[(\d+)\]/);
                    if (match) metadata.dimension = parseInt(match[1]);
                }

                metadata.documents = (savePayload.documents || shadowDocsMap.get(instanceId) || []) as unknown as ShadowDoc[];

                const container = { type: 'orama-state', metadata, state };
                
                // CRITICAL FIX: Use JSON.stringify for the container to avoid MsgPack recursion depth limits
                // Orama tries (radix trees) are naturally very deep.
                const serialized = new TextEncoder().encode(JSON.stringify(container));
                let output = serialized;
                
                if (payload?.compress) {
                    output = fflate.zlibSync(serialized);
                }
                
                ctx.postMessage({ 
                    success: true, instanceId, id, 
                    payload: { data: output, compressed: !!payload?.compress, metadata } 
                }, [output.buffer]);
                break;

            case 'SEARCH':
                if (!db) throw new Error(`Instance not found`);
                if (!payload) throw new Error('Missing payload for SEARCH');
                const searchPayload = payload as unknown as OramaSearchPayload;

                // Defensive check for vector dimension mismatch
                if (searchPayload.mode === 'vector' || searchPayload.vector) {
                    const queryVector = (searchPayload.vector as { value?: number[] })?.value || searchPayload.vector as number[];
                    const schema: AnySchema = schemas.get(instanceId)!;
                    if ((schema as unknown as Record<string, unknown>)?.embedding) {
                        const match = String((schema as unknown as Record<string, unknown>).embedding).match(/vector\[(\d+)\]/);
                        const expectedDim = match ? parseInt(match[1]) : 0;
                        if (queryVector && Array.isArray(queryVector) && queryVector.length !== expectedDim) {
                            throw new Error(`DIMENSION_MISMATCH: Expected ${expectedDim}, got ${queryVector.length}. Please rebuild the index for the current model.`);
                        }
                    }
                }

                const searchResults = await search(db, (searchPayload.params || searchPayload) as Parameters<typeof search>[1]);
                ctx.postMessage({ success: true, instanceId, id, payload: { results: searchResults } });
                break;

            case 'INSERT_BATCH':
                if (!payload) throw new Error('Missing payload for INSERT_BATCH');
                if (!db) {
                    let dim = 0;
                    const docs = payload as unknown as OramaInsertPayload;
                    if (docs.documents?.[0]?.embedding) dim = (docs.documents[0].embedding as number[]).length;
                    db = await initInstance(instanceId, buildSchema(dim));
                }
                
                const currentShadow = shadowDocsMap.get(instanceId) || [];
                const insertDocs = (payload as unknown as OramaInsertPayload).documents || [];
                for (const doc of insertDocs) {
                    await insert(db, doc);
                    currentShadow.push({
                        path: String(doc.path || ''),
                        chunkIndex: Number(doc.chunkIndex || 0),
                        lastModified: Number(doc.lastModified || 0),
                        hasEmbedding: doc.embedding ? true : false,
                        content: String(doc.content || '')
                    });
                }
                shadowDocsMap.set(instanceId, currentShadow);
                ctx.postMessage({ success: true, instanceId, id });
                break;

            case 'REMOVE':
                if (db && payload) {
                    const removePayload = payload as unknown as OramaRemovePayload;
                    if (removePayload.docId) {
                        await remove(db, removePayload.docId);
                        const shadow = shadowDocsMap.get(instanceId) || [];
                        shadowDocsMap.set(instanceId, shadow.filter((d: ShadowDoc) => `${d.path}:${d.chunkIndex}` !== removePayload.docId));
                    }
                }
                ctx.postMessage({ success: true, instanceId, id });
                break;

            case 'CLEAR':
                const schema = schemas.get(instanceId);
                if (schema) await initInstance(instanceId, schema);
                else { instances.delete(instanceId); schemas.delete(instanceId); shadowDocsMap.delete(instanceId); }
                ctx.postMessage({ success: true, instanceId, id });
                break;

            case 'CLEAR_FILE':
                if (db && payload) {
                    const clearPayload = payload as unknown as OramaRemovePayload;
                    const shadow = shadowDocsMap.get(instanceId) || [];
                    const docsToRemove = shadow.filter((d: ShadowDoc) => d.path === clearPayload.path);
                    for (const doc of docsToRemove) {
                        await remove(db, `${doc.path}:${doc.chunkIndex}`);
                    }
                    shadowDocsMap.set(instanceId, shadow.filter((d: ShadowDoc) => d.path !== clearPayload.path));
                }
                ctx.postMessage({ success: true, instanceId, id });
                break;

            case 'GET_METADATA':
                ctx.postMessage({ 
                    success: true, instanceId, id, 
                    payload: { metadata: metadatas.get(instanceId), documents: shadowDocsMap.get(instanceId) } 
                });
                break;

            default:
                throw new Error(`Unknown type: ${type}`);
        }
    } catch (error) {
                ctx.postMessage({
            success: false, instanceId, id,
            error: error instanceof Error ? error.message : String(error)
        });
        }
    })();
});
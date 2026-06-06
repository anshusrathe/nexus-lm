import { create, insert, search, save, load, remove } from '@orama/orama';
import * as fflate from 'fflate';
import { decode } from '@msgpack/msgpack';

interface OramaWorkerMessage {
    type: 'INIT' | 'SEARCH' | 'INSERT' | 'INSERT_BATCH' | 'SAVE' | 'LOAD' | 'REMOVE' | 'CLEAR' | 'CLEAR_FILE' | 'GET_METADATA';
    instanceId: string;
    id?: string;
    payload?: any;
}

interface OramaWorkerResponse {
    success: boolean;
    instanceId: string;
    id?: string;
    payload?: any;
    error?: string;
}

const ctx: Worker = self as any;
const instances: Map<string, any> = new Map();
const schemas: Map<string, any> = new Map();
const metadatas: Map<string, any> = new Map();
const shadowDocsMap: Map<string, any[]> = new Map();

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

function createDb(schema: any) {
    return create({ schema, components: { tokenizer: tokenizerConfig } });
}


function buildSchema(dimension: number = 0) {
    const schema: any = {
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
    return schema;
}

async function initInstance(instanceId: string, schema: any) {
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

ctx.addEventListener('message', async (event: MessageEvent<OramaWorkerMessage>) => {
    const { type, instanceId, id, payload } = event.data;
    let db = instances.get(instanceId);

    try {
        switch (type) {
            case 'INIT':
                await initInstance(instanceId, payload.schema);
                metadatas.set(instanceId, payload.metadata || {});
                ctx.postMessage({ success: true, instanceId, id });
                break;

            case 'LOAD':
                try {
                    let binaryData = payload.data;
                    if (payload.compressed) binaryData = fflate.unzlibSync(new Uint8Array(binaryData));
                    
                    let decoded: any;
                    
                    // Format Detection: Check if it starts with '{' (JSON) or something else (MsgPack)
                    const firstByte = new Uint8Array(binaryData)[0];
                    if (firstByte === 123) { // '{' character
                                                decoded = JSON.parse(new TextDecoder().decode(binaryData));
                    } else {
                                                decoded = decode(binaryData);
                    }
                    
                    let shadowDocs: any[] = [];
                    
                    if (decoded.type === 'orama-state') {
                        // NEW Container format
                        const metadata = decoded.metadata || {};
                        const dimension = metadata.dimension || 0;
                        const schema = buildSchema(dimension);
                        
                        const newDb = await createDb(schema);
                        await load(newDb, decoded.state);
                        
                        instances.set(instanceId, newDb);
                        schemas.set(instanceId, schema);
                        metadatas.set(instanceId, metadata);
                        
                        shadowDocs = metadata.documents || [];
                        shadowDocsMap.set(instanceId, shadowDocs);
                    } else if (decoded.documents && Array.isArray(decoded.documents)) {
                        // Migration from old SearchIndex
                        const docs = decoded.documents;
                        let dim = 0;
                        for (const d of docs) {
                            if (d.embedding?.length > 0) { dim = d.embedding.length; break; }
                        }
                        
                        const schema = buildSchema(dim);
                        const newDb = await initInstance(instanceId, schema);
                        
                        shadowDocs = [];
                        for (const doc of docs) {
                            const meta = doc.metadata || {};
                            const oramaDoc: any = {
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
                                hasEmbedding: doc.embedding?.length > 0 ? true : false,
                                content: doc.content || ''
                            });
                        }
                        
                        metadatas.set(instanceId, {
                            lastUpdated: decoded.lastUpdated || Date.now(),
                            version: 6,
                            model: decoded.model,
                            dimension: dim
                        });
                        shadowDocsMap.set(instanceId, shadowDocs);
                    }
                    
                    ctx.postMessage({ 
                        success: true, instanceId, id, 
                        payload: { metadata: metadatas.get(instanceId), documents: shadowDocs } 
                    });
                } catch (e: any) {
                                        throw new Error(`Load failed: ${e.message}`);
                }
                break;

            case 'SAVE':
                if (!db) throw new Error(`Instance not found`);
                const state = await save(db);
                const metadata = { ...(payload?.metadata || metadatas.get(instanceId) || {}) };
                
                // Track dimension
                const currentSchema = schemas.get(instanceId);
                if (currentSchema?.embedding) {
                    const match = currentSchema.embedding.match(/vector\[(\d+)\]/);
                    if (match) metadata.dimension = parseInt(match[1]);
                }

                metadata.documents = payload?.documents || shadowDocsMap.get(instanceId) || [];

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

                // Defensive check for vector dimension mismatch
                if (payload.params.mode === 'vector' || payload.params.vector) {
                    const queryVector = payload.params.vector?.value || payload.params.vector;
                    const schema = schemas.get(instanceId);
                    if (schema?.embedding) {
                        const match = schema.embedding.match(/vector\[(\d+)\]/);
                        const expectedDim = match ? parseInt(match[1]) : 0;
                        if (queryVector && Array.isArray(queryVector) && queryVector.length !== expectedDim) {
                            throw new Error(`DIMENSION_MISMATCH: Expected ${expectedDim}, got ${queryVector.length}. Please rebuild the index for the current model.`);
                        }
                    }
                }

                const searchResults = await search(db, payload.params);
                ctx.postMessage({ success: true, instanceId, id, payload: { results: searchResults } });
                break;

            case 'INSERT_BATCH':
                if (!db) {
                    let dim = 0;
                    if (payload.documents?.[0]?.embedding) dim = payload.documents[0].embedding.length;
                    db = await initInstance(instanceId, buildSchema(dim));
                }
                
                const currentShadow = shadowDocsMap.get(instanceId) || [];
                for (const doc of (payload.documents || [])) {
                    await insert(db, doc);
                    currentShadow.push({
                        path: doc.path,
                        chunkIndex: doc.chunkIndex,
                        lastModified: doc.lastModified || 0,
                        hasEmbedding: doc.embedding ? true : false,
                        content: doc.content || ''
                    });
                }
                shadowDocsMap.set(instanceId, currentShadow);
                ctx.postMessage({ success: true, instanceId, id });
                break;

            case 'REMOVE':
                if (db) {
                    await remove(db, payload.docId);
                    const shadow = shadowDocsMap.get(instanceId) || [];
                    shadowDocsMap.set(instanceId, shadow.filter(d => `${d.path}:${d.chunkIndex}` !== payload.docId));
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
                if (db) {
                    const shadow = shadowDocsMap.get(instanceId) || [];
                    const docsToRemove = shadow.filter(d => d.path === payload.path);
                    for (const doc of docsToRemove) {
                        await remove(db, `${doc.path}:${doc.chunkIndex}`);
                    }
                    shadowDocsMap.set(instanceId, shadow.filter(d => d.path !== payload.path));
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
});

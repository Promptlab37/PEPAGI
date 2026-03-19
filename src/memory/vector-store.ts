// ═══════════════════════════════════════════════════════════════
// PEPAGI — Vector Store (TF-IDF + Optional Ollama Embeddings)
// ═══════════════════════════════════════════════════════════════

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "it", "in", "on", "at", "to", "for",
  "of", "and", "or", "but",
]);

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

/** Cached TF-IDF corpus data, keyed by a fingerprint of the document set. */
interface TFIDFCache {
  fingerprint: string;
  vocab: Map<string, number>;
  docFreq: Map<string, number>;
  numDocs: number;
  docTokens: string[][];
}

export class VectorStore {
  // PERF-01: was rebuilding TF-IDF on every search call; cache it with a
  // fingerprint derived from item ids so it is only rebuilt when corpus changes.
  private tfidfCache: TFIDFCache | null = null;

  /**
   * Tokenize text into normalized terms, stripping stop words.
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 1 && !STOP_WORDS.has(w));
  }

  /**
   * Build a TF-IDF vector for a document given a corpus vocabulary.
   * @param terms - Tokenized document
   * @param vocab - Global vocabulary (term → index)
   * @param docFreq - Map of term → number of documents containing it
   * @param numDocs - Total number of documents in corpus
   * @returns Un-normalized TF-IDF vector
   */
  private tfidfVector(
    terms: string[],
    vocab: Map<string, number>,
    docFreq: Map<string, number>,
    numDocs: number,
  ): number[] {
    const vec = new Array<number>(vocab.size).fill(0);
    const termCount = terms.length;
    if (termCount === 0) return vec;

    // Term frequency per document
    const tf = new Map<string, number>();
    for (const t of terms) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }

    for (const [term, freq] of tf) {
      const idx = vocab.get(term);
      if (idx === undefined) continue;
      const tfVal = freq / termCount;
      const df = docFreq.get(term) ?? 0;
      const idfVal = Math.log(numDocs / (1 + df));
      vec[idx] = tfVal * idfVal;
    }
    return vec;
  }

  /**
   * Normalize a vector to unit length (L2 norm).
   */
  private normalize(vec: number[]): number[] {
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm === 0) return vec;
    return vec.map(v => v / norm);
  }

  /**
   * Compute cosine similarity between two (unit-normalized) vectors.
   * @param a - First vector
   * @param b - Second vector
   * @returns Similarity score in [0, 1]
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += (a[i] ?? 0) * (b[i] ?? 0);
    }
    // Clamp to [0, 1] to handle floating-point drift
    return Math.max(0, Math.min(1, dot));
  }

  /**
   * Compute a TF-IDF vector for a single text, standalone.
   * Useful for comparing a query against pre-stored vectors.
   * @param text - Input text
   * @returns Normalized TF-IDF vector
   */
  vectorize(text: string): number[] {
    const terms = this.tokenize(text);
    const vocab = new Map<string, number>();
    for (const t of terms) {
      if (!vocab.has(t)) vocab.set(t, vocab.size);
    }
    // Single-document corpus — IDF = log(1 / (1+1)) = log(0.5), constant
    const vec = new Array<number>(vocab.size).fill(0);
    const termCount = terms.length;
    if (termCount === 0) return vec;
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [term, freq] of tf) {
      const idx = vocab.get(term);
      if (idx === undefined) continue;
      vec[idx] = freq / termCount;
    }
    return this.normalize(vec);
  }

  /**
   * Semantic search over items using TF-IDF vectors.
   * Builds a corpus from all items + query, then ranks by cosine similarity.
   * @param query - Search query
   * @param items - Items to search over
   * @param topK - Maximum number of results (default 5)
   * @returns Top-K items sorted by descending score
   */
  semanticSearch<T>(
    query: string,
    items: Array<{ id: string; text: string; data: T }>,
    topK = 5,
  ): Array<{ id: string; score: number; data: T }> {
    if (items.length === 0) return [];

    // PERF-01: build corpus data once per unique document set; only rebuild
    // when the fingerprint (joined item ids) changes.
    const fingerprint = items.map(i => i.id).join("\x00");
    if (!this.tfidfCache || this.tfidfCache.fingerprint !== fingerprint) {
      const docTokens = items.map(item => this.tokenize(item.text));

      // Build global vocabulary (documents only; query is added per-call below)
      const vocab = new Map<string, number>();
      for (const doc of docTokens) {
        for (const t of doc) {
          if (!vocab.has(t)) vocab.set(t, vocab.size);
        }
      }

      // Build document frequency map
      const docFreq = new Map<string, number>();
      for (const doc of docTokens) {
        const seen = new Set<string>();
        for (const t of doc) {
          if (!seen.has(t)) {
            docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
            seen.add(t);
          }
        }
      }

      this.tfidfCache = { fingerprint, vocab, docFreq, numDocs: docTokens.length, docTokens };
    }

    const { vocab, docFreq, docTokens } = this.tfidfCache;

    // Include the query as an extra document so IDF is computed over the full
    // corpus + query (preserves the original behaviour).
    const queryTerms = this.tokenize(query);
    const allDocs = [...docTokens, queryTerms];

    // Extend vocab and docFreq with any query-only terms
    const queryOnlyVocab = new Map<string, number>(vocab);
    const queryOnlyDocFreq = new Map<string, number>(docFreq);
    {
      const seen = new Set<string>();
      for (const t of queryTerms) {
        if (!queryOnlyVocab.has(t)) queryOnlyVocab.set(t, queryOnlyVocab.size);
        if (!seen.has(t)) {
          queryOnlyDocFreq.set(t, (queryOnlyDocFreq.get(t) ?? 0) + 1);
          seen.add(t);
        }
      }
    }

    const numDocs = allDocs.length;
    // Use the query-extended vocab/docFreq so query-unique terms get proper IDF
    const queryVec = this.normalize(this.tfidfVector(queryTerms, queryOnlyVocab, queryOnlyDocFreq, numDocs));

    // Score each item
    const scored = items.map((item, i) => {
      const docTerms = allDocs[i]!;
      const docVec = this.normalize(this.tfidfVector(docTerms, queryOnlyVocab, queryOnlyDocFreq, numDocs));
      const score = this.cosineSimilarity(queryVec, docVec);
      return { id: item.id, score, data: item.data };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Attempt to get neural embeddings from Ollama nomic-embed-text.
   * Returns null if Ollama is unavailable or times out.
   * @param text - Text to embed
   * @returns Embedding vector or null
   */
  async neuralVectorize(text: string): Promise<number[] | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (!res.ok) return null;

      const data = await res.json() as { embedding?: number[] };
      if (!Array.isArray(data.embedding) || data.embedding.length === 0) return null;

      return this.normalize(data.embedding as number[]);
    } catch {
      return null;
    }
  }

  /**
   * Hybrid search: uses Ollama neural embeddings when available, falls back to TF-IDF.
   * @param query - Search query
   * @param items - Items to search over
   * @param topK - Maximum number of results (default 5)
   * @returns Top-K items sorted by descending score
   */
  async hybridSearch<T>(
    query: string,
    items: Array<{ id: string; text: string; data: T }>,
    topK = 5,
  ): Promise<Array<{ id: string; score: number; data: T }>> {
    if (items.length === 0) return [];

    // Attempt neural embeddings
    const queryEmbedding = await this.neuralVectorize(query);

    if (queryEmbedding !== null) {
      // PERF-02: batch Ollama HTTP requests with Promise.all in chunks of 20
      // to avoid overwhelming the local server with a single giant batch.
      const BATCH_SIZE = 20;
      const embeddingResults: Array<number[] | null> = [];
      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(item => this.neuralVectorize(item.text)),
        );
        embeddingResults.push(...batchResults);
      }

      // If any item embedding failed, fall back to TF-IDF
      const allSucceeded = embeddingResults.every(e => e !== null);

      if (allSucceeded) {
        const scored = items.map((item, i) => {
          const docVec = embeddingResults[i]!;
          const score = this.cosineSimilarity(queryEmbedding, docVec);
          return { id: item.id, score, data: item.data };
        });

        return scored
          .filter(s => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);
      }
    }

    // TF-IDF fallback
    return this.semanticSearch(query, items, topK);
  }
}

/** Singleton vector store instance */
export const vectorStore = new VectorStore();

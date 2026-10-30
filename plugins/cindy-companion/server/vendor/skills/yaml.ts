import matter from 'gray-matter';

// The upstream reader parses one isolated block scalar, never a caller's YAML
// object. Reuse the plugin's existing YAML engine with the same load semantics.
export default {
  load(source: string): unknown {
    return matter(`---\n${source}\n---\n`).data;
  },
};

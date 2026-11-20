import '../shared/analysis.js';
import { parseExportify } from './trackData.js';

self.onmessage = async ({ data }) => {
  try {
    if (data.action === 'csv') {
      self.postMessage({ result: parseExportify(await data.file.text(), { allowEmpty: data.allowEmpty }) });
      return;
    }
    const analysis = self.PlaylistAnalysis;
    const result = data.action === 'genre'
      ? analysis.sequenceGenreClusters(data.tracks, data.options)
      : analysis.optimizeMixOrder(data.tracks, data.options);
    self.postMessage({ result: result.map((track) => track.rowId) });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};

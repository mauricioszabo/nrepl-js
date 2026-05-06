// Format a CDP RemoteObject into a printable string suitable for nREPL.
// We get RemoteObjects from Runtime.evaluate (without returnByValue) and from
// Runtime.consoleAPICalled args.

export function formatRemoteObject(ro) {
  if (!ro) return '';
  if (ro.unserializableValue) return String(ro.unserializableValue);
  if (ro.type === 'undefined') return 'undefined';
  if (ro.type === 'string') return ro.value;
  if (ro.type === 'number' || ro.type === 'boolean' || ro.type === 'bigint') return String(ro.value);
  if (ro.type === 'symbol') return ro.description ?? 'Symbol()';
  if (ro.type === 'function') return ro.description ?? '[Function]';
  if (ro.subtype === 'null') return 'null';

  // Objects: prefer description (e.g. "Array(3)", "Error: boom"), fall back to preview.
  if (ro.preview) return previewToString(ro.preview);
  if (ro.description) return ro.description;
  return '[object]';
}

function previewToString(p) {
  if (p.subtype === 'array') {
    const items = (p.properties ?? []).map(propValue);
    const overflow = p.overflow ? ', …' : '';
    return '[ ' + items.join(', ') + overflow + ' ]';
  }
  const items = (p.properties ?? []).map((pp) => `${pp.name}: ${propValue(pp)}`);
  const overflow = p.overflow ? ', …' : '';
  const desc = p.description && p.description !== 'Object' ? p.description + ' ' : '';
  return desc + '{ ' + items.join(', ') + overflow + ' }';
}

function propValue(p) {
  if (p.type === 'string') return JSON.stringify(p.value);
  if (p.type === 'object') return p.value ?? '[object]';
  return p.value ?? '';
}

// Format an exceptionDetails block (from Runtime.evaluate / exceptionThrown)
// as a printable error string and a short class name.
export function formatException(ed) {
  if (!ed) return { text: '', className: 'Error' };
  const exc = ed.exception;
  let text;
  if (exc) {
    text = exc.description ?? exc.value ?? ed.text ?? 'Error';
  } else {
    text = ed.text ?? 'Error';
  }
  const className = (exc && exc.className) || 'Error';
  return { text: String(text), className };
}

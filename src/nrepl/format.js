
export async function parseResult(cdp, result, depth = 0) {
  // console.log("RES", depth, result)

  if(!result) {
    return
  }
  switch(result.type) {
    case('string'):
      return ["string", result.description || result.value]
    case('undefined'):
      return ["literal", 'undefined']
    case('number'):
      return ["number", result.description]
    case('boolean'):
      return ["boolean", result.value, result.value ? 1 : 0]
    case('object'):
      if(result.subtype == 'null') return ['literal', 'null']
      if(depth < 10) {
        const res = await cdp.send('Runtime.getProperties', {
          objectId: result.objectId,
          ownProperties: true,
        })
        if(result.subtype === 'array') {
          const keyvals = res.result.filter(i => i.name.match(/^\d+$/)).map(i =>
            parseResult(cdp, i.value, depth + 1)
          )
          return [
            'coll', result.className === 'Array' ? '': `Object [${result.className}] `,
            '[', ', ', ']',
            await Promise.all(keyvals)
          ]
        } else {
          const keyvals = res.result.filter(i => typeof i.name == 'string').map(i => {
            return parseResult(cdp, i.value, depth + 1).then(parsedVal => {
              return [["literal", i.name], parsedVal]
            })
          })
          return [
            'map', result.className === 'Object' ? '': `[object ${result.className}] `,
            '{', ': ', ', ', '}',
            await Promise.all(keyvals)
          ]
        }
      } else {
        if(result.className === 'Object') {
          return ['...', '[object]', result.objectId]
        } else {
          return ['...', `${result.className} {...}`, result.objectId]
        }
      }
    case('function'):
      if(result.className === 'Function') {
        let descr = '[function]'
        const match = result.description.match(/(class|function) ([^\s\(]+)/)
        if(match) {
          descr = `[${match[0]}]`
        }  else if(result.description.indexOf('[native code]') > -1) {
          descr = '[native function]'
        }
        return [ "literal", descr]
      } else {
        return ["literal", result.className]
      }
    default:
      return ["literal", result.description || result.value]
  }
}

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
  if (!ed) return ''
  const exc = ed.exception;
  if (exc) {
    return exc.description ?? exc.value ?? ed.text ?? 'Error';
  } else {
    return ed.text ?? 'Error';
  }
}

// The `eval` op: routes either to Runtime.evaluate (default) or to the
// patcher (when the client passed `file` and the code is a set of named
// top-level decls that already exist in that script).

import { parseResult } from './format.js';

export async function handleEval({ msg, session, cdp, scripts, send }) {
  const code = msg.code ?? '';
  const file = msg.file;

  console.log("EVAL\n", code)
  if (file) {
    const watchPointsRes = await cdp.send('Runtime.evaluate', {
      expression: `globalThis.__lazuli?.watchPoints["${file}"]`,
      returnByValue: true
    })

    if(watchPointsRes.result.type == 'undefined') {
      send({ id: msg.id, session: session.id, ex: noWatch(file), status: ['done', 'error'] })
      return
    }
    const watchPoints = watchPointsRes.result.value
    let row
    for (row = msg.line; row > -1; row--) {
      if(watchPoints[row]) break
    }
    if(row == -1) {
      send({ id: msg.id, session: session.id, ex: noWatch(file), status: ['done', 'error'] })
      return
    }
    const normalizedCode = code.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const watchPoint = await cdp.send('Runtime.evaluate', {
      expression: `globalThis.__lazuli?.watchPoints["${file}"][${row}]`,
      // generatePreview: true
    })

    console.log("HIT WATCH", `globalThis.__lazuli?.watchPoints["${file}"][${row}]`)

    const evalResult = await cdp.send('Runtime.callFunctionOn', {
      objectId: watchPoint.result.objectId,
      functionDeclaration: 'function(text) { return this(text) }',
      arguments: [{value: code}]
    })
    const parsedResult = JSON.stringify({result: await parseResult(cdp, evalResult.result)})
    console.log("PARSED", parsedResult)
    send({ id: msg.id, session: session.id, value: parsedResult, status: ['done'] })
  } else {
    const normalizedCode = code.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const evalResult = await cdp.send('Runtime.evaluate', {
      expression: `globalThis.__lazuli?.watchPoints["${file}"][${row}]("${normalizedCode}")`,
      // generatePreview: true
    })
    const parsedResult = JSON.stringify({result: await parseResult(cdp, evalResult.result)})
    send({ id: msg.id, session: session.id, value: parsedResult, status: ['done'] })
  }
}

// import repl from 'node:repl';
// let r = true
// async function parseResult(cdp, result, depth = 0) {
//   console.log("RES", depth, result)
//   // global.cdp = cdp
//   // global.result = result
//   // if(r) {
//   //   const server = repl.start({
//   //     prompt: '> ',
//   //     useColors: true,
//   //   });
//   //   r = false
//   // }
//
//   if(!result) {
//     return
//   }
//   switch(result.type) {
//     case('string'):
//       return ["string", result.description || result.value]
//     case('undefined'):
//       return ["literal", 'undefined']
//     case('number'):
//       return ["number", result.description]
//     case('boolean'):
//       return ["boolean", result.value, result.value ? 1 : 0]
//     case('object'):
//       if(result.subtype == 'null') return ['literal', 'null']
//       if(depth < 10) {
//         const res = await cdp.send('Runtime.getProperties', {
//           objectId: result.objectId,
//           ownProperties: true,
//         })
//         const keyvals = res.result.filter(i => typeof i.name == 'string').map(i => {
//           console.log("KEYVAL", i.name, i)
//           return parseResult(cdp, i.value, depth + 1).then(parsedVal => {
//             return [["literal", i.name], parsedVal]
//           })
//         })
//         if(result.subtype === 'array') {
//           return [
//             'coll', result.className === 'Array' ? '': `Object [${result.className}] `,
//             '[', ', ', ']',
//             (await Promise.all(keyvals)).map(e => e[1])
//           ]
//         } else {
//           return [
//             'map', result.className === 'Object' ? '': `[object ${result.className}] `,
//             '{', ': ', ', ', '}',
//             await Promise.all(keyvals)
//           ]
//         }
//       } else {
//         if(result.className === 'Object') {
//           return ['...', '[object]', result.objectId]
//         } else {
//           return ['...', `${result.className} {...}`, result.objectId]
//         }
//       }
//     case('function'):
//       // const res = await cdp.send('Runtime.getProperties', {
//       //   objectId: result.objectId,
//       //   ownProperties: true,
//       // })
//       // console.log("FUN", res)
//       if(result.className === 'Function') {
//         let descr = '[function]'
//         const match = result.description.match(/(class|function) ([^\s\(]+)/)
//         if(match) {
//           descr = `[${match[0]}]`
//         }  else if(result.description.indexOf('[native code]') > -1) {
//           descr = '[native function]'
//         }
//         return [ "literal", descr]
//       } else {
//         return ["literal", result.className]
//       }
//     default:
//       return ["literal", result.description || result.value]
//       // obj.preview.properties.map(code
//   }
//
//   // cdp.send('Runtime.getProperties', {
//   //   objectId: result.result.objectId,
//   //   ownProperties: true,
//   //   accessorPropertiesOnly: false,
//   //   generatePreview: true
//   // }).then(a => res = a)
//
//
//   // result
//   // switch(result.type) {
//   //   case 'undefined':
//   //     return 'undefined'
//   //   default:
//   //     if(result.value) {
//   //
//   //     } else {
//   //       return JSON.stringify(result.description)
//   //     }
//   // }
// }

function noWatch(file) {
  return JSON.stringify(['literal', `No watch points reachable for ${file}`])
}

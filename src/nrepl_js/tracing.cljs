(ns nrepl-js.tracing
  (:require ["node:fs/promises" :as fs]
            [nrepl-js.cdp-interop :as cdp]))

(defn- add-debug-point [^js cdp url file ^js path]
  (let [loc (.. path -node -body -loc)]
    (when loc
      (let [line (.. loc -start -line)
            default-watch "{ watchPoints: {}, watchPointsIds: {}, sources: {}}"
            add-watch-cmd (str "((globalThis.__lazuli ||= " default-watch
                               ").watchPoints['" file "'] ||= {})"
                               "[" (dec line) "] = (code) => eval(code)")
            condition (str "(" add-watch-cmd ") && false")]
        (js/console.log "Adding debugger" file line)
        (-> (cdp/call cdp "Debugger.setBreakpointByUrl"
                      {:url url
                       :lineNumber line
                       :condition condition})
            (.then (fn [r] (prn "Added debugger" file line r)))
            (.catch (fn [r] (prn "Failed debugger" file line r))))))))

(defn instrument-source [^js cdp ev]
  (let [url (:url ev)
        file-name (.replace url #"file://" "")]
    (-> (.readFile fs file-name "utf-8")
        (.then (fn [contents]
                 ;; Skip files already instrumented by the Babel build plugin —
                 ;; it installs new Function(originalNames,...) watch-points that
                 ;; are more useful than the plain eval closure we'd set here.
                 (when-not (js* "globalThis.__lazuli?.babelFiles?.has(~{})" file-name)
                   (js/console.log "Instrumenting?" file-name)
                   (let [parsed (js* "require('@babel/parser').parse(~{})" contents)
                         add-fn (fn [path] (add-debug-point cdp url file-name path))]
                     (js* "require('@babel/traverse').default(~{}, {
                         FunctionDeclaration: function(p) { ~{}(p) },
                         ObjectMethod: function(p) { ~{}(p) },
                         ClassMethod: function(p) { ~{}(p) },
                         ClassPrivateMethod: function(p) { ~{}(p) }
                       })" parsed add-fn add-fn add-fn add-fn)))))
        (.catch (fn [_] nil)))))

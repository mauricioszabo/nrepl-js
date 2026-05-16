(ns nrepl-js.tracing
  (:require ["node:fs/promises" :as fs]
            ["node:path" :as path]
            ["@babel/parser" :as babel]
            ["source-map" :refer [SourceMapConsumer]]
            [promesa.core :as p]
            [clojure.string :as str]
            [nrepl-js.cdp-interop :as cdp]))


#_
(p/-> cdp
      (cdp/call "Debugger.getPossibleBreakpoints"
                {:start {:scriptId "1201"
                         :lineNumber 9
                         :columnNumber (dec column)}
                 :restrictToFunction true})
      :locations)

(defn- ^:async set-breakpoint [cdp script-id line column file original-row path]
  (let [default-watch "{ watchPoints: {}, watchPointsIds: {}, sources: {}}"
        add-watch-cmd (str "((globalThis.__lazuli ||= " default-watch
                          ").watchPoints['" file "'] ||= {})"
                          "[" (dec original-row) "] = (code) => eval(code)")
        add-watch-cmd (str "(" add-watch-cmd ") && console.log('HIT WATCH', '" file "', " original-row ", 'on', '" (.. path -node -id -name) "')")
        condition (if (re-find #"dynamic_table" file)
                    (str "(" add-watch-cmd ") || true")
                    (str "(" add-watch-cmd ") && false"))
        first-breakpoint (-> cdp
                             (cdp/call "Debugger.getPossibleBreakpoints"
                                       {:start {:scriptId script-id
                                                :lineNumber (dec line)
                                                :columnNumber (dec column)}
                                        :restrictToFunction true})
                             await
                             :locations
                             first)]
    (when first-breakpoint
      (-> (cdp/call cdp "Debugger.setBreakpoint"
                    {:location first-breakpoint
                     :condition condition})
          (.then (fn [r]
                   (print "\nInstrumenting " file " on code " (.. path -node -id -name))
                   (prn "Added debugger" script-id line column r)))
          (.catch (fn [r] (prn "Failed debugger" script-id line column r)))))))

(defn instrument-source [contents add-fn]
  (let [parsed (try
                 (. babel parse contents #js {:sourceType "unambiguous"
                                              :plugins #js ["jsx"
                                                            "typescript"
                                                            "classProperties"
                                                            "classPrivateProperties"
                                                            "classPrivateMethods"
                                                            "dynamicImport"
                                                            "importMeta"]})
                 (catch :default _))]
    (when parsed
      (js* "require('@babel/traverse').default(~{}, {
            FunctionDeclaration: function(p) { ~{}(p) },
            ObjectMethod: function(p) { ~{}(p) },
            ClassMethod: function(p) { ~{}(p) },
            ClassPrivateMethod: function(p) { ~{}(p) }
          })" parsed add-fn add-fn add-fn add-fn))))

(defn ^:async instrument-file [cdp ev]
  (let [file-name (.replace (:url ev) #"file://" "")
        contents (await (.readFile fs file-name "utf-8"))]
    (instrument-source contents
                       (fn [^js path]
                         (when-let [loc (.. path -node -body -loc)]
                           (set-breakpoint cdp (:scriptId ev)
                                           (.. loc -start -line) 1
                                           file-name (.. loc -start -line)
                                           path))))))

(defn- ^:async trace-from-source-map [cdp ev]
  (when-let [source-map (-> ev :sourceMapURL not-empty)]
    (let [sm-url (.-href (js/URL. source-map (:url ev)))
          ^js f (await (js/fetch sm-url))
          ^js data (await (.json f))
          ;; FIXME - this might need to change
          normalize-fs-name #(str (js/process.cwd)
                                  "/"
                                  (str/replace % #"^(\.\./)+" ""))]
      (. SourceMapConsumer with data nil
        (fn [^js consumer]
          (def data data)
          (doseq [[source-name source] (map vector (.-sources data) (.-sourcesContent data))
                  :let [file (normalize-fs-name source-name)]
                  :when (not (re-find #"node_modules" file))]
            (def file file)
            (def source source)
            (instrument-source source
                               (fn [^js path]
                                 (def path path)
                                 (when-let [loc (.. path -node -body -loc)]
                                   (let [final (.generatedPositionFor
                                                consumer
                                                #js {:source source-name,
                                                     :line (.. loc -start -line)
                                                     :column (.. loc -start -column)})]
                                     (set-breakpoint cdp
                                                     (:scriptId ev) (.-line final) (.-column final)
                                                     file (.. loc -start -line)
                                                     path)))))))))))

#_
(trace-from-source-map cdp ev)
(defn start-trace! [cdp]
  (cdp/on cdp "Debugger.scriptParsed"
          (fn [{:keys [url] :as ev}]
            (def cdp cdp)
            (when (re-find #"dynamic_table" url)
              (def ev ev)
              #_
              (def a
                (-> (js/URL. (:sourceMapURL ev) (:url ev))
                    .-pathname
                    dirname)))
            (cond
              (str/starts-with? url "http")
              (when (re-find #"table" url)
                (trace-from-source-map cdp ev))

              (str/starts-with? url "file")
              (when-not (re-find #"node_modules" (or url ""))
                (.catch (instrument-file cdp ev) identity))))))

#_
(cdp/call cdp "")

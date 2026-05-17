(ns nrepl-js.console
  (:require [nrepl-js.format :as fmt]
            [promesa.core :as p]))

(def ^:private stderr-types #{"error" "warn" "assert" "exception"})

(defn attach-console [^js cdp on-message]
  (.call (.-on cdp) cdp "Runtime.consoleAPICalled"
         (fn [^js params]
           (let [stream (if (stderr-types (.-type params)) "err" "out")
                 args (array-seq (or (.-args params) (array)))
                 text (str (.join (into-array (map fmt/format-remote-object args)) " ") "\n")
                 structured-log (map (fn [^js obj]
                                       (if (= (.-type obj) "string")
                                         (p/resolved #js {:string (.-value obj)})
                                         (p/let [result (fmt/parse-result cdp obj)]
                                           #js {:structured result})))
                                     args)]
             (-> (p/all structured-log)
                 (p/then (fn [l]
                           (on-message {:stream stream
                                        :text text
                                        :structured (conj (vec l) #js {:string "\n"})})))))))

  (.call (.-on cdp) cdp "Runtime.exceptionThrown"
         (fn [^js params]
           (let [text (fmt/format-exception (.-exceptionDetails params))]
             (on-message {:stream "err" :text (str text "\n")})))))

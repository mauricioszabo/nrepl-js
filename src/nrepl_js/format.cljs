(ns nrepl-js.format
  (:require [promesa.core :as p]))

(declare parse-result)

(defn- preview->string [^js prev]
  (let [props (array-seq (.-properties prev))
        overflow (if (.-overflow prev) ", …" "")]
    (if (= (.-subtype prev) "array")
      (let [items (map (fn [^js p]
                         (let [t (.-type p) v (.-value p)]
                           (cond
                             (= t "string") (js/JSON.stringify v)
                             (= t "object") (or v "[object]")
                             :else (str (or v ""))))) props)]
        (str "[ " (.join (into-array items) ", ") overflow " ]"))
      (let [items (map (fn [^js pp]
                         (let [t (.-type pp) v (.-value pp)
                               val (cond
                                     (= t "string") (js/JSON.stringify v)
                                     (= t "object") (or v "[object]")
                                     :else (str (or v "")))]
                           (str (.-name pp) ": " val))) props)
            desc (let [d (.-description prev)]
                   (if (and d (not= d "Object")) (str d " ") ""))]
        (str desc "{ " (.join (into-array items) ", ") overflow " }")))))

(defn format-remote-object [^js ro]
  (cond
    (not ro) ""
    (.-unserializableValue ro) (str (.-unserializableValue ro))
    (= (.-type ro) "undefined") "undefined"
    (= (.-type ro) "string") (.-value ro)
    (= (.-type ro) "number") (str (.-value ro))
    (= (.-type ro) "boolean") (str (.-value ro))
    (= (.-type ro) "bigint") (str (.-value ro))
    (= (.-type ro) "symbol") (or (.-description ro) "Symbol()")
    (= (.-type ro) "function") (or (.-description ro) "[Function]")
    (= (.-subtype ro) "null") "null"
    (.-preview ro) (preview->string (.-preview ro))
    (.-description ro) (.-description ro)
    :else "[object]"))

(defn format-exception [^js ed]
  (when ed
    (let [^js exc (.-exception ed)]
      (if exc
        (or (.-description exc) (.-value exc) (.-text ed) "Error")
        (or (.-text ed) "Error")))))

(defn parse-result
  ([cdp result] (parse-result cdp result 0))
  ([^js cdp ^js result depth]
   (when result
     (let [t (.-type result)]
       (cond
         (= t "string")
         (p/resolved (array "string" (or (.-description result) (.-value result))))

         (= t "undefined")
         (p/resolved (array "literal" "undefined"))

         (= t "number")
         (p/resolved (array "number" (.-description result)))

         (= t "boolean")
         (p/resolved (array "boolean" (.-value result) (if (.-value result) 1 0)))

         (= t "object")
         (if (= (.-subtype result) "null")
           (p/resolved (array "literal" "null"))
           (if (< depth 10)
             (p/let [^js res (.call (.-send cdp) cdp "Runtime.getProperties"
                                    #js {:objectId (.-objectId result) :ownProperties true})]
               (if (= (.-subtype result) "array")
                 (let [keyvals (->> (array-seq (.-result res))
                                    (filter #(re-find #"^\d+$" (.-name ^js %)))
                                    (map #(parse-result cdp (.-value ^js %) (inc depth))))]
                   (p/let [resolved (p/all keyvals)]
                     (array "coll"
                            (if (= (.-className result) "Array") "" (str "Object [" (.-className result) "] "))
                            "[" ", " "]"
                            (into-array resolved))))
                 (let [keyvals (->> (array-seq (.-result res))
                                    (filter #(string? (.-name ^js %)))
                                    (map (fn [^js i]
                                           (p/let [parsed-val (parse-result cdp (.-value i) (inc depth))]
                                             (array (array "literal" (.-name i)) parsed-val)))))]
                   (p/let [resolved (p/all keyvals)]
                     (array "map"
                            (if (= (.-className result) "Object") "" (str "[object " (.-className result) "] "))
                            "{" ": " ", " "}"
                            (into-array resolved))))))
             (if (= (.-className result) "Object")
               (p/resolved (array "..." "[object]" (.-objectId result)))
               (p/resolved (array "..." (str (.-className result) " {...}") (.-objectId result))))))

         (= t "function")
         (if (= (.-className result) "Function")
           (let [descr (let [desc (.-description result)
                             m (when desc (re-find #"(class|function) ([^\s\(]+)" desc))]
                         (cond
                           m (str "[" (first m) "]")
                           (and desc (.includes desc "[native code]")) "[native function]"
                           :else "[function]"))]
             (p/resolved (array "literal" descr)))
           (p/resolved (array "literal" (.-className result))))

         :else
         (p/resolved (array "literal" (or (.-description result) (.-value result)))))))))

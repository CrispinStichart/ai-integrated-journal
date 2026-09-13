// @ts-nocheck -- Exact upstream behavior baseline; Task 4 modernizes its types.
export * from "./EBML.js";
import Decoder from "./EBMLDecoder.js";
import Encoder from "./EBMLEncoder.js";
import Reader from "./EBMLReader.js";
import * as tools from "./tools.js";

export {
  Decoder,
  Encoder,
  Reader,
  tools
};

#!/usr/bin/env python3
"""Export nvidia/nemotron-labs-unified-asr-0.6b to ONNX in the onnx-asr "nemo-conformer-rnnt" layout.

Writes OUT/encoder-model.onnx(+.data), OUT/decoder_joint-model.onnx, OUT/vocab.txt, OUT/config.json
(and *.int8.onnx with --int8). The model is EncDecRNNTBPEModelWithPrompt: after the FastConformer encoder a
one-hot language prompt is concatenated and projected back (prompt_kernel). The exported encoder bakes in one
prompt (--lang, default "auto"), so the files are a plain FastConformer-RNNT that onnx-asr loads as is.
--prompt-input keeps prompt_index (int64, see config.json prompt_dictionary) as a third encoder input instead.

Usage (CPU, ~10 GB RAM, ~3 min):  python scripts/export_onnx.py OUT [--lang auto] [--prompt-input] [--int8]
Load: onnx_asr.load_model("nemo-conformer-rnnt", OUT, quantization="int8").with_timestamps()
"""
import argparse, json, os, shutil, tempfile

import onnx
import torch
import nemo.collections.asr as nemo_asr

ap = argparse.ArgumentParser()
ap.add_argument("out")
ap.add_argument("--model", default="nvidia/nemotron-labs-unified-asr-0.6b")
ap.add_argument("--lang", default="auto", help="prompt baked into the encoder (auto, ru, es, en-US, ...)")
ap.add_argument("--prompt-input", action="store_true", help="make the prompt an encoder input instead")
ap.add_argument("--int8", action="store_true", help="also write *.int8.onnx (MatMul-only dynamic int8 encoder)")
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)

m = nemo_asr.models.ASRModel.from_pretrained(a.model, map_location="cpu").eval()
pd = dict(m.cfg.model_defaults.get("prompt_dictionary") or {})


class Enc(torch.nn.Module):
    """encoder -> concat one-hot prompt -> prompt_kernel, as EncDecRNNTBPEModelWithPrompt.forward does."""
    def __init__(self, m, pid):
        super().__init__()
        self.enc, self.pk, self.P, self.pid = m.encoder, m.prompt_kernel, m.num_prompts, pid

    def forward(self, audio_signal, length, prompt_index=None):
        e, el = self.enc(audio_signal=audio_signal, length=length)       # B x D x T
        e = e.transpose(1, 2)
        if prompt_index is None:
            prompt_index = torch.full((e.shape[0],), self.pid, dtype=torch.long)
        oh = torch.nn.functional.one_hot(prompt_index, self.P).to(e.dtype)[:, None, :].expand(-1, e.shape[1], -1)
        return self.pk(torch.cat([e, oh], -1)).transpose(1, 2), el


with torch.no_grad():
    enc = Enc(m, pd[a.lang]).eval()
    x, l = torch.randn(1, m.cfg.preprocessor.features, 400), torch.tensor([400])
    args, names = (x, l), ["audio_signal", "length"]
    if a.prompt_input:
        args, names = (x, l, torch.tensor([pd[a.lang]])), names + ["prompt_index"]
    axes = {"audio_signal": {0: "B", 2: "T"}, "length": {0: "B"}, "outputs": {0: "B", 2: "T"},
            "encoded_lengths": {0: "B"}, **({"prompt_index": {0: "B"}} if a.prompt_input else {})}
    tmp = tempfile.mkdtemp(dir=a.out)  # torch writes one file per tensor; consolidate into one .data file
    torch.onnx.export(enc, args, f"{tmp}/enc.onnx", input_names=names, output_names=["outputs", "encoded_lengths"],
                      dynamic_axes=axes, opset_version=17, dynamo=False, external_data=True)
    onnx.save_model(onnx.load(f"{tmp}/enc.onnx"), f"{a.out}/encoder-model.onnx", save_as_external_data=True,
                    all_tensors_to_one_file=True, location="encoder-model.onnx.data", size_threshold=1024)
    shutil.rmtree(tmp)
    # NeMo's own export: encoder (no prompt projection, discarded) + decoder_joint
    # (inputs encoder_outputs, targets, target_length, input_states_1/2).
    tmp = tempfile.mkdtemp(dir=a.out)
    m.export(f"{tmp}/m.onnx", onnx_opset_version=17, check_trace=False)
    shutil.move(f"{tmp}/decoder_joint-m.onnx", f"{a.out}/decoder_joint-model.onnx")
    shutil.rmtree(tmp)

with open(f"{a.out}/vocab.txt", "w") as v:
    for i, t in enumerate(m.tokenizer.vocab):
        v.write(f"{t} {i}\n")
    v.write(f"<blk> {len(m.tokenizer.vocab)}\n")
json.dump({"model_type": "nemo-conformer-rnnt", "features_size": m.cfg.preprocessor.features,
           "subsampling_factor": 8, "prompt_language": None if a.prompt_input else a.lang,
           "prompt_dictionary": pd}, open(f"{a.out}/config.json", "w"), indent=1, ensure_ascii=False)

if a.int8:  # per-channel or all-op quantization hurt badly in tests (empty output / 2x WER); MatMul-only is fine
    from onnxruntime.quantization import QuantType, quantize_dynamic
    quantize_dynamic(f"{a.out}/encoder-model.onnx", f"{a.out}/encoder-model.int8.onnx",
                     weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul"])
    shutil.copy(f"{a.out}/decoder_joint-model.onnx", f"{a.out}/decoder_joint-model.int8.onnx")  # 49 MB, keep fp32
print(sorted((f, os.path.getsize(f"{a.out}/{f}") >> 20) for f in os.listdir(a.out)))

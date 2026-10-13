"""Independent integrated-loudness/oversampled-peak verification; dev only."""
import json, subprocess, sys, tempfile, pathlib
import numpy as np
import scipy, scipy.signal
import pyloudnorm as pyln
from importlib.metadata import version
root = pathlib.Path(__file__).resolve().parents[1]
cases = []
with tempfile.TemporaryDirectory(prefix='audio-audit-reference-') as folder:
    inputs = [root/'examples/fixtures/narration-a.ogg', root/'examples/fixtures/narration-b.ogg']
    tone = pathlib.Path(folder)/'tone.wav'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','aevalsrc=0.1*sin(2*PI*1000*t):s=48000:d=12','-c:a','pcm_f32le',str(tone)],check=True)
    high = pathlib.Path(folder)/'intersample.wav'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','aevalsrc=0.8*sin(2*PI*12000*t+PI/4):s=48000:d=12','-af','afade=t=in:d=0.05,afade=t=out:st=11.95:d=0.05','-c:a','pcm_f32le',str(high)],check=True)
    inputs += [tone, high]
    for audio in inputs:
        report=json.loads(subprocess.check_output(['node',str(root/'dist/cjs/cli.js'),'analyze',str(audio),'--json']))
        rate=report['input']['selectedStream']['sampleRate'];channels=report['input']['selectedStream']['channels']
        raw=subprocess.check_output(['ffmpeg','-v','error','-i',str(audio),'-c:a','pcm_f64le','-f','f64le','pipe:1'])
        samples=np.frombuffer(raw,dtype='<f8').reshape(-1,channels)
        reference=float(pyln.Meter(rate,filter_class='DeMan').integrated_loudness(samples))
        error=abs(report['integratedLufs']-reference)
        assert error <= .15, (audio.name,error)
        # Independent band-limited oversampling on an interior region avoids artificial EOF padding peaks.
        middle=samples[rate: min(len(samples)-rate,rate*11)]
        oversampled=scipy.signal.resample_poly(middle,16,1,axis=0,window=('kaiser',8.6))
        peak=20*np.log10(np.max(np.abs(oversampled)))
        peak_error=abs(report['truePeakDbtp']-float(peak))
        assert peak_error<=.25,(audio.name,peak_error)
        cases.append({'file':audio.name,'integratedLufs':report['integratedLufs'],'independentLufs':reference,'errorLu':error,'truePeakDbtp':report['truePeakDbtp'],'independentInteriorOversampledPeakDb':float(peak),'peakErrorDb':peak_error})
record={'python':sys.version.split()[0],'pyloudnorm':version('pyloudnorm'),'numpy':np.__version__,'scipy':scipy.__version__,'loudnessToleranceLu':.15,'peakToleranceDb':.25,'cases':cases,'limits':'Four fixtures, not a full ITU certification. Peak reference examines interior signal, not encoder padding edges.'}
(root/'artifacts').mkdir(exist_ok=True)
(root/'artifacts/independent-reference.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record,indent=2))

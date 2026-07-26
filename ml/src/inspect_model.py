# File: ml/src/inspect_model.py
# Purpose: Inspect the Two-Tower Neural Network model architecture to extract
#          input/output shapes and layer names for backend integration.

import os
import sys

MODEL_PATH = os.path.join(os.path.dirname(__file__), "..", "models", "student_engagement_model.keras")

def inspect_model(model_path=MODEL_PATH):
    try:
        import tensorflow as tf
        print(f"TensorFlow version: {tf.__version__}")
        
        print(f"\nLoading model from: {model_path}")
        model = tf.keras.models.load_model(model_path)
        
        print("\n" + "="*60)
        print("MODEL ARCHITECTURE SUMMARY")
        print("="*60)
        model.summary()
        
        print("\n" + "="*60)
        print("INPUT DETAILS")
        print("="*60)
        if isinstance(model.input, list):
            for i, inp in enumerate(model.input):
                print(f"  Input {i}: name='{inp.name}', shape={inp.shape}, dtype={inp.dtype}")
        else:
            print(f"  Input: name='{model.input.name}', shape={model.input.shape}")

        print("\n" + "="*60)
        print("OUTPUT DETAILS")
        print("="*60)
        if isinstance(model.output, list):
            for i, out in enumerate(model.output):
                print(f"  Output {i}: name='{out.name}', shape={out.shape}")
        else:
            print(f"  Output: name='{model.output.name}', shape={model.output.shape}")

        return model
        
    except Exception as e:
        print(f"Error loading model: {e}")
        return None

if __name__ == "__main__":
    inspect_model()

import os
from PIL import Image
import numpy as np

def make_transparent():
    input_path = '/home/gayathri/.gemini/antigravity-ide/brain/a953cf7a-5d5e-405b-b00f-2b6fcd83c8af/media__1784358847621.png'
    output_path = '/home/gayathri/shebloom/frontend/public/images/dr_deepa_mobile_onboarding.png'
    
    if not os.path.exists(input_path):
        print(f"Error: Input file {input_path} not found.")
        return

    print("Opening image...")
    img = Image.open(input_path).convert("RGBA")
    data = np.array(img)

    # Make pixels that are very close to black transparent
    # Black is R < 15, G < 15, B < 15
    r, g, b, a = data[:,:,0], data[:,:,1], data[:,:,2], data[:,:,3]
    black_mask = (r < 15) & (g < 15) & (b < 15)
    
    data[black_mask, 3] = 0  # Set alpha to 0 for black pixels

    # Create new image from data
    new_img = Image.fromarray(data)

    # Crop bounding box of non-transparent pixels
    bbox = new_img.getbbox()
    if bbox:
        new_img = new_img.crop(bbox)
        print(f"Cropped to bounding box: {bbox}")

    print(f"Saving transparent cutout to {output_path}...")
    new_img.save(output_path, "PNG")
    print("Success!")

if __name__ == "__main__":
    make_transparent()

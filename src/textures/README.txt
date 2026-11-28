All source textures are CC0 from Poly Haven (https://polyhaven.com): asphalt_07, red_brick, large_sandstone_blocks_01,
roof_slates_03, concrete_pavement. Re-encoded and channel-packed to keep fragment shaders <= 8 sampler units:
- asphalt_07_diff_1k.jpg        asphalt diffuse (sRGB)
- asphalt_07_nrf_1k.webp        R,G = asphalt normal x,y (OpenGL) ; B = asphalt roughness ; A = concrete_pavement luminance (for roads)
- photo_detail.webp (1024)      R = red_brick, G = large_sandstone_blocks_01, B = roof_slates_03, A = concrete_pavement (diffuse luminance, sRGB-encoded)
- photo_nrm_a.webp (512)        RG = red_brick normal xy, BA = sandstone normal xy

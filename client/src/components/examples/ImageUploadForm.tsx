import ImageUploadForm from "../ImageUploadForm";

export default function ImageUploadFormExample() {
  const handleSubmit = async (data: any) => {
    console.log("Upload triggered with data:", data);
    await new Promise(resolve => setTimeout(resolve, 1500));
  };

  return <ImageUploadForm onSubmit={handleSubmit} />;
}

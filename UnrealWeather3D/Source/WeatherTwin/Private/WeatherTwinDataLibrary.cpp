#include "WeatherTwinDataLibrary.h"

#include "Dom/JsonObject.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

FString FWeatherTwinDataLibrary::ResolveDataPath(const FString& RelativeOrAbsolutePath)
{
    if (FPaths::IsRelative(RelativeOrAbsolutePath))
    {
        return FPaths::ConvertRelativePathToFull(FPaths::ProjectDir(), RelativeOrAbsolutePath);
    }
    return RelativeOrAbsolutePath;
}

bool FWeatherTwinDataLibrary::ReadJsonObject(const FString& Path, TSharedPtr<FJsonObject>& OutObject)
{
    FString JsonText;
    if (!FFileHelper::LoadFileToString(JsonText, *ResolveDataPath(Path)))
    {
        UE_LOG(LogTemp, Warning, TEXT("WeatherTwin: failed to read JSON %s"), *Path);
        return false;
    }

    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(JsonText);
    return FJsonSerializer::Deserialize(Reader, OutObject) && OutObject.IsValid();
}

bool FWeatherTwinDataLibrary::LoadCloudVolume(const FString& MetaPath, TArray<uint8>& OutBytes, FWeatherVolumeMeta& OutMeta)
{
    TSharedPtr<FJsonObject> Root;
    if (!ReadJsonObject(MetaPath, Root))
    {
        return false;
    }

    const TSharedPtr<FJsonObject>* Shape = nullptr;
    if (!Root->TryGetObjectField(TEXT("shape"), Shape))
    {
        return false;
    }

    OutMeta.X = (*Shape)->GetIntegerField(TEXT("x"));
    OutMeta.Y = (*Shape)->GetIntegerField(TEXT("y"));
    OutMeta.Z = (*Shape)->GetIntegerField(TEXT("z"));

    const FString DataFile = Root->GetStringField(TEXT("data"));
    const FString DataPath = FPaths::Combine(FPaths::GetPath(MetaPath), DataFile);
    return FFileHelper::LoadFileToArray(OutBytes, *ResolveDataPath(DataPath));
}

bool FWeatherTwinDataLibrary::LoadWindFrame(const FString& MetaPath, TArray<float>& OutU, TArray<float>& OutV, TArray<float>& OutW, FWeatherVolumeMeta& OutMeta)
{
    TSharedPtr<FJsonObject> Root;
    if (!ReadJsonObject(MetaPath, Root))
    {
        return false;
    }

    const TSharedPtr<FJsonObject>* Shape = nullptr;
    const TSharedPtr<FJsonObject>* Components = nullptr;
    if (!Root->TryGetObjectField(TEXT("shape"), Shape) || !Root->TryGetObjectField(TEXT("components"), Components))
    {
        return false;
    }

    OutMeta.X = (*Shape)->GetIntegerField(TEXT("x"));
    OutMeta.Y = (*Shape)->GetIntegerField(TEXT("y"));
    OutMeta.Z = (*Shape)->GetIntegerField(TEXT("z"));
    double SpeedP95 = OutMeta.SpeedP95MetersPerSecond;
    if (Root->TryGetNumberField(TEXT("speed_p95_ms"), SpeedP95))
    {
        OutMeta.SpeedP95MetersPerSecond = static_cast<float>(SpeedP95);
    }

    auto LoadFloatComponent = [&](const FString& Field, TArray<float>& OutValues)
    {
        TArray<uint8> Bytes;
        const FString FileName = (*Components)->GetStringField(Field);
        const FString ComponentPath = FPaths::Combine(FPaths::GetPath(MetaPath), FileName);
        if (!FFileHelper::LoadFileToArray(Bytes, *ResolveDataPath(ComponentPath)))
        {
            return false;
        }

        const int32 Count = Bytes.Num() / sizeof(float);
        OutValues.SetNumUninitialized(Count);
        FMemory::Memcpy(OutValues.GetData(), Bytes.GetData(), Count * sizeof(float));
        return true;
    };

    return LoadFloatComponent(TEXT("u"), OutU)
        && LoadFloatComponent(TEXT("v"), OutV)
        && LoadFloatComponent(TEXT("w"), OutW);
}

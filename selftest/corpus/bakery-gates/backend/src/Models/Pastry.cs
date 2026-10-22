using System;

namespace Bakery.Gates.Models
{
    public class PastryRequest
    {
        public string Name { get; set; }
    }

    public class OvenFaultException : Exception
    {
    }

    public static class Toggles
    {
        public const string StrictKitchen = "strict-kitchen";
    }
}
